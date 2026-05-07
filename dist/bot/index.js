"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuperBot = void 0;
const discord_js_1 = require("discord.js");
const dotenv = __importStar(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const bullmq_1 = require("bullmq");
const queue_1 = require("../queue");
const embeds_1 = require("./embeds");
dotenv.config();
class SuperBot {
    client;
    commands;
    deliveryWorker = null;
    constructor() {
        this.client = new discord_js_1.Client({
            intents: [
                discord_js_1.GatewayIntentBits.Guilds,
                discord_js_1.GatewayIntentBits.GuildMessages,
            ]
        });
        this.commands = new discord_js_1.Collection();
    }
    async start() {
        if (!process.env.DISCORD_TOKEN) {
            throw new Error('DISCORD_TOKEN is missing in .env');
        }
        await this.loadCommands();
        this.registerEvents();
        await this.client.login(process.env.DISCORD_TOKEN);
        console.log(`🤖 Bot logged in as ${this.client.user?.tag}`);
        this.startDeliveryDispatcher();
    }
    startDeliveryDispatcher() {
        console.log('🚀 Starting Discord Delivery Dispatcher...');
        this.deliveryWorker = new bullmq_1.Worker('discord_delivery', async (job) => {
            if (job.name === 'discord_alert') {
                await this.dispatchAlert(job.data);
            }
        }, {
            connection: queue_1.redisConnection,
            concurrency: 2 // Discord rate limits are strict, keep concurrency low
        });
    }
    async dispatchAlert(data) {
        try {
            const channel = await this.client.channels.fetch(data.channelId);
            if (!channel || !channel.isTextBased())
                return;
            if (data.alertType === 'WHALE_BUY') {
                const embed = (0, embeds_1.createWhaleBuyEmbed)(data);
                // Add interactive buttons
                const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
                    .setLabel('View on Blur')
                    .setStyle(discord_js_1.ButtonStyle.Link)
                    .setURL(`https://blur.io/collection/${data.contract}`), new discord_js_1.ButtonBuilder()
                    .setCustomId(`stats_${data.wallet}`)
                    .setLabel('View Wallet Stats')
                    .setStyle(discord_js_1.ButtonStyle.Secondary), new discord_js_1.ButtonBuilder()
                    .setCustomId(`mute_${data.wallet}`)
                    .setLabel('Mute this Wallet')
                    .setStyle(discord_js_1.ButtonStyle.Danger));
                await channel.send({ embeds: [embed], components: [row] });
            }
            else if (data.alertType === 'MINT_RADAR') {
                const embed = (0, embeds_1.createMintAlertEmbed)(data);
                // Add interactive buttons
                const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
                    .setLabel('View Contract')
                    .setStyle(discord_js_1.ButtonStyle.Link)
                    .setURL(`https://etherscan.io/address/${data.contract}`));
                await channel.send({ embeds: [embed], components: [row] });
            }
        }
        catch (error) {
            console.error(`[Delivery] Failed to dispatch alert to channel ${data.channelId}:`, error);
        }
    }
    async loadCommands() {
        const commandsPath = path_1.default.join(__dirname, 'commands');
        if (!fs_1.default.existsSync(commandsPath))
            return;
        const commandFiles = fs_1.default.readdirSync(commandsPath).filter(file => file.endsWith('.ts') || file.endsWith('.js'));
        const restCommands = [];
        for (const file of commandFiles) {
            const filePath = path_1.default.join(commandsPath, file);
            const command = await Promise.resolve(`${filePath}`).then(s => __importStar(require(s)));
            if ('data' in command && 'execute' in command) {
                console.log(`📦 Loading command: /${command.data.name}`);
                this.commands.set(command.data.name, command);
                restCommands.push(command.data.toJSON());
            }
        }
        if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_TOKEN) {
            try {
                const rest = new discord_js_1.REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
                // If DEV_GUILD_ID is provided, register to that guild for INSTANT updates
                if (process.env.DEV_GUILD_ID) {
                    console.log(`⚡ Registering ${restCommands.length} commands to DEV GUILD: ${process.env.DEV_GUILD_ID}`);
                    await rest.put(discord_js_1.Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DEV_GUILD_ID), { body: restCommands });
                }
                else {
                    console.log(`🌐 Registering ${restCommands.length} commands GLOBALLY (may take 1h)...`);
                    await rest.put(discord_js_1.Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: restCommands });
                }
                console.log('✅ Commands registered successfully.');
            }
            catch (error) {
                console.error('❌ Error registering commands:', error);
            }
        }
    }
    registerEvents() {
        this.client.on('interactionCreate', async (interaction) => {
            if (interaction.isChatInputCommand()) {
                const command = this.commands.get(interaction.commandName);
                if (!command)
                    return;
                try {
                    await command.execute(interaction);
                }
                catch (error) {
                    console.error(error);
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
                    }
                    else {
                        await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                    }
                }
            }
            else if (interaction.isButton()) {
                // Handle interactive buttons from alerts
                const [action, target] = interaction.customId.split('_');
                if (action === 'mute') {
                    // In V2, this would add the wallet to a 'muted' table per-user/guild
                    await interaction.reply({ content: `🚫 Muted alerts for \`${target}\` in this channel (Mock).`, ephemeral: true });
                }
                else if (action === 'stats') {
                    await interaction.reply({ content: `📊 Fetching detailed historical PnL for \`${target}\`...`, ephemeral: true });
                    // Trigger the /wallet command logic or similar embed response
                }
            }
        });
    }
}
exports.SuperBot = SuperBot;
