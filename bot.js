const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

// Configuration
const CONFIG = {
    FAUCET_API_URL: 'https://rpc-testnet.supra.com/rpc/v3/wallet/faucet/',
    RATE_LIMIT_WINDOW: 3600000, // 1 hour in milliseconds
    MAX_REQUESTS_PER_HOUR: 3, // Maximum requests per user per hour
    COOLDOWN_BETWEEN_REQUESTS: 300000, // 5 minutes between requests
    BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    GUILD_ID: process.env.DISCORD_GUILD_ID // Optional: for guild-specific commands
};

// In-memory storage for rate limiting (in production, consider using Redis)
const userRequests = new Map();
const userCooldowns = new Map();

// Supra address validation (basic validation - adjust based on actual Supra address format)
function isValidSupraAddress(address) {
    // Supra addresses are typically 64 characters long and start with '0x'
    const supraAddressRegex = /^0x[a-fA-F0-9]{64}$/;
    return supraAddressRegex.test(address);
}

// Rate limiting check
function checkRateLimit(userId) {
    const now = Date.now();
    
    // Check cooldown
    if (userCooldowns.has(userId)) {
        const lastRequest = userCooldowns.get(userId);
        if (now - lastRequest < CONFIG.COOLDOWN_BETWEEN_REQUESTS) {
            const timeLeft = Math.ceil((CONFIG.COOLDOWN_BETWEEN_REQUESTS - (now - lastRequest)) / 1000 / 60);
            return { allowed: false, reason: `Please wait ${timeLeft} minutes before requesting again.` };
        }
    }
    
    // Check hourly limit
    if (!userRequests.has(userId)) {
        userRequests.set(userId, []);
    }
    
    const requests = userRequests.get(userId);
    const recentRequests = requests.filter(timestamp => now - timestamp < CONFIG.RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= CONFIG.MAX_REQUESTS_PER_HOUR) {
        return { allowed: false, reason: `You've reached the hourly limit of ${CONFIG.MAX_REQUESTS_PER_HOUR} requests. Please try again later.` };
    }
    
    return { allowed: true };
}

// Update user request tracking
function updateRateLimit(userId) {
    const now = Date.now();
    
    if (!userRequests.has(userId)) {
        userRequests.set(userId, []);
    }
    
    const requests = userRequests.get(userId);
    requests.push(now);
    
    // Clean up old requests
    const recentRequests = requests.filter(timestamp => now - timestamp < CONFIG.RATE_LIMIT_WINDOW);
    userRequests.set(userId, recentRequests);
    
    // Update cooldown
    userCooldowns.set(userId, now);
}

// Request tokens from faucet
async function requestTokens(address) {
    try {
        const response = await axios.get(`${CONFIG.FAUCET_API_URL}${address}`, {
            timeout: 15000,
            headers: {
                'User-Agent': 'SupraFaucetBot/1.0'
            }
        });
        
        return {
            success: true,
            data: response.data,
            status: response.status
        };
    } catch (error) {
        console.error('Faucet API Error:', error.response?.data || error.message);
        
        if (error.response) {
            return {
                success: false,
                error: `API Error: ${error.response.status} - ${error.response.data?.message || 'Unknown error'}`,
                status: error.response.status
            };
        } else if (error.code === 'ECONNABORTED') {
            return {
                success: false,
                error: 'Request timeout - the faucet service is not responding'
            };
        } else {
            return {
                success: false,
                error: 'Network error - unable to reach faucet service'
            };
        }
    }
}

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Slash command definition
const commands = [
    new SlashCommandBuilder()
        .setName('faucet')
        .setDescription('Request testnet tokens for Supra blockchain development')
        .addStringOption(option =>
            option
                .setName('address')
                .setDescription('Your Supra wallet address (0x...)')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('faucet-help')
        .setDescription('Get help and information about the Supra testnet faucet'),
    new SlashCommandBuilder()
        .setName('faucet-status')
        .setDescription('Check your current rate limit status')
];

// Register slash commands
async function registerCommands() {
    try {
        const rest = new REST({ version: '10' }).setToken(CONFIG.BOT_TOKEN);
        
        console.log('Started refreshing application (/) commands.');
        
        if (CONFIG.GUILD_ID) {
            // Guild-specific commands (faster for development)
            await rest.put(
                Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
                { body: commands }
            );
        } else {
            // Global commands
            await rest.put(
                Routes.applicationCommands(CONFIG.CLIENT_ID),
                { body: commands }
            );
        }
        
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Bot ready event
client.once('ready', async () => {
    console.log(`🚀 Supra Faucet Bot is online as ${client.user.tag}!`);
    console.log(`📊 Serving ${client.guilds.cache.size} guild(s)`);
    
    // Set bot status
    client.user.setActivity('Supra Testnet | /faucet help', { type: 'WATCHING' });
    
    await registerCommands();
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName, user } = interaction;
    
    try {
        if (commandName === 'faucet') {
            await handleFaucetCommand(interaction);
        } else if (commandName === 'faucet-help') {
            await handleHelpCommand(interaction);
        } else if (commandName === 'faucet-status') {
            await handleStatusCommand(interaction);
        }
    } catch (error) {
        console.error('Command error:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle('❌ Bot Error')
            .setDescription('An unexpected error occurred. Please try again later.')
            .setTimestamp();
        
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
});

// Handle faucet command
async function handleFaucetCommand(interaction) {
    const address = interaction.options.getString('address');
    const userId = interaction.user.id;
    
    // Defer reply as API calls might take time
    await interaction.deferReply();
    
    // Validate address format
    if (!isValidSupraAddress(address)) {
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle('❌ Invalid Address')
            .setDescription('Please provide a valid Supra wallet address.\n\n**Format:** `0x` followed by 64 hexadecimal characters\n**Example:** `0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`')
            .setTimestamp();
        
        return await interaction.editReply({ embeds: [errorEmbed] });
    }
    
    // Check rate limits
    const rateLimitCheck = checkRateLimit(userId);
    if (!rateLimitCheck.allowed) {
        const limitEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('⏰ Rate Limited')
            .setDescription(rateLimitCheck.reason)
            .addFields([
                {
                    name: 'ℹ️ Limits',
                    value: `• **${CONFIG.MAX_REQUESTS_PER_HOUR}** requests per hour\n• **${CONFIG.COOLDOWN_BETWEEN_REQUESTS / 1000 / 60}** minutes between requests`,
                    inline: false
                }
            ])
            .setTimestamp();
        
        return await interaction.editReply({ embeds: [limitEmbed] });
    }
    
    // Request tokens
    const result = await requestTokens(address);
    
    if (result.success) {
        // Update rate limiting
        updateRateLimit(userId);
        
        const successEmbed = new EmbedBuilder()
            .setColor('#4ECDC4')
            .setTitle('✅ Tokens Sent Successfully!')
            .setDescription('Testnet tokens have been sent to your address.')
            .addFields([
                {
                    name: '📧 Address',
                    value: `\`${address}\``,
                    inline: false
                },
                {
                    name: '🌐 Network',
                    value: 'Supra Testnet',
                    inline: true
                },
                {
                    name: '⏰ Next Request',
                    value: `<t:${Math.floor((Date.now() + CONFIG.COOLDOWN_BETWEEN_REQUESTS) / 1000)}:R>`,
                    inline: true
                }
            ])
            .setFooter({ text: 'Happy building on Supra! 🚀' })
            .setTimestamp();
        
        await interaction.editReply({ embeds: [successEmbed] });
    } else {
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle('❌ Faucet Request Failed')
            .setDescription(result.error || 'Failed to request tokens from the faucet.')
            .addFields([
                {
                    name: '💡 Troubleshooting',
                    value: '• Check if your address is correct\n• Ensure you haven\'t recently received tokens\n• Try again in a few minutes\n• Contact support if the issue persists',
                    inline: false
                }
            ])
            .setTimestamp();
        
        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

// Handle help command
async function handleHelpCommand(interaction) {
    const helpEmbed = new EmbedBuilder()
        .setColor('#4ECDC4')
        .setTitle('🚿 Supra Testnet Faucet Bot')
        .setDescription('Get free testnet tokens for developing on the Supra blockchain!')
        .addFields([
            {
                name: '📋 Commands',
                value: '• `/faucet <address>` - Request testnet tokens\n• `/faucet-status` - Check your rate limit status\n• `/faucet-help` - Show this help message',
                inline: false
            },
            {
                name: '🔒 Rate Limits',
                value: `• **${CONFIG.MAX_REQUESTS_PER_HOUR}** requests per hour\n• **${CONFIG.COOLDOWN_BETWEEN_REQUESTS / 1000 / 60}** minutes between requests`,
                inline: false
            },
            {
                name: '📝 Address Format',
                value: 'Supra addresses start with `0x` followed by 64 hexadecimal characters',
                inline: false
            },
            {
                name: '🌐 Useful Links',
                value: '[Supra Documentation](https://docs.supra.com) | [Testnet Explorer](https://testnet.suprascan.io)',
                inline: false
            }
        ])
        .setFooter({ text: 'Built for Supra developers ❤️' })
        .setTimestamp();
    
    await interaction.reply({ embeds: [helpEmbed] });
}

// Handle status command
async function handleStatusCommand(interaction) {
    const userId = interaction.user.id;
    const now = Date.now();
    
    let requestsThisHour = 0;
    let requestsToday = 0;
    let nextRequestTime = null;
    
    if (userRequests.has(userId)) {
        const requests = userRequests.get(userId);
        requestsThisHour = requests.filter(timestamp => now - timestamp < CONFIG.RATE_LIMIT_WINDOW).length;
    }
    
    if (userDailyRequests.has(userId)) {
        const dailyRequests = userDailyRequests.get(userId);
        requestsToday = dailyRequests.filter(timestamp => now - timestamp < CONFIG.DAILY_LIMIT_WINDOW).length;
    }
    
    if (userCooldowns.has(userId)) {
        const lastRequest = userCooldowns.get(userId);
        const cooldownEnd = lastRequest + CONFIG.COOLDOWN_BETWEEN_REQUESTS;
        if (now < cooldownEnd) {
            nextRequestTime = cooldownEnd;
        }
    }
    
    const statusEmbed = new EmbedBuilder()
        .setColor('#4ECDC4')
        .setTitle('📊 Your Faucet Status')
        .addFields([
            {
                name: '📈 Requests This Hour',
                value: `${requestsThisHour}/${CONFIG.MAX_REQUESTS_PER_HOUR}`,
                inline: true
            },
            {
                name: '📅 Requests Today',
                value: `${requestsToday}/${CONFIG.DAILY_LIMIT}`,
                inline: true
            },
            {
                name: '⏰ Next Request Available',
                value: nextRequestTime ? `<t:${Math.floor(nextRequestTime / 1000)}:R>` : 'Now!',
                inline: true
            }
        ])
        .setTimestamp();
    
    await interaction.reply({ embeds: [statusEmbed], ephemeral: true });
}

// Error handling
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Login to Discord
if (!CONFIG.BOT_TOKEN) {
    console.error('❌ DISCORD_BOT_TOKEN environment variable is required!');
    process.exit(1);
}

if (!CONFIG.CLIENT_ID) {
    console.error('❌ DISCORD_CLIENT_ID environment variable is required!');
    process.exit(1);
}

client.login(CONFIG.BOT_TOKEN);