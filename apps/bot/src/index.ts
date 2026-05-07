import { Client, GatewayIntentBits, Collection, REST, Routes, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, BaseInteraction } from 'discord.js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Worker, Job } from 'bullmq';
import { redisConnection } from '@superbot/queue';
import { createWhaleBuyEmbed, createMintAlertEmbed } from './embeds';

dotenv.config();

export class SuperBot {
    public client: Client;
    public commands: Collection<string, any>;
    private deliveryWorker: Worker | null = null;

    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
            ]
        });
        this.commands = new Collection();
    }

    public async start() {
        if (!process.env.DISCORD_TOKEN) {
            throw new Error('DISCORD_TOKEN is missing in .env');
        }

        await this.loadCommands();
        this.registerEvents();

        await this.client.login(process.env.DISCORD_TOKEN);
        console.log(`🤖 Bot logged in as ${this.client.user?.tag}`);

        this.startDeliveryDispatcher();
    }

    private startDeliveryDispatcher() {
        console.log('🚀 Starting Discord Delivery Dispatcher...');
        this.deliveryWorker = new Worker('discord_delivery', async (job: Job) => {
            if (job.name === 'discord_alert') {
                await this.dispatchAlert(job.data);
            }
        }, {
            connection: redisConnection,
            concurrency: 2 // Discord rate limits are strict, keep concurrency low
        });
    }

    private async dispatchAlert(data: any) {
        try {
            const channel = await this.client.channels.fetch(data.channelId) as TextChannel;
            if (!channel || !channel.isTextBased()) return;

            if (data.alertType === 'WHALE_BUY') {
                const embed = createWhaleBuyEmbed(data);
                
                // Add interactive buttons
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel('View on Blur')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://blur.io/collection/${data.contract}`),
                    new ButtonBuilder()
                        .setCustomId(`stats_${data.wallet}`)
                        .setLabel('View Wallet Stats')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`mute_${data.wallet}`)
                        .setLabel('Mute this Wallet')
                        .setStyle(ButtonStyle.Danger)
                );

                await channel.send({ embeds: [embed], components: [row] });
            } else if (data.alertType === 'MINT_RADAR') {
                const embed = createMintAlertEmbed(data);
                
                // Add interactive buttons
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel('View Contract')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://etherscan.io/address/${data.contract}`)
                );

                await channel.send({ embeds: [embed], components: [row] });
            }
        } catch (error) {
            console.error(`[Delivery] Failed to dispatch alert to channel ${data.channelId}:`, error);
        }
    }

    private async loadCommands() {
        const commandsPath = path.join(__dirname, 'commands');
        if (!fs.existsSync(commandsPath)) return;

        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.ts') || file.endsWith('.js'));

        const restCommands = [];

        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = await import(filePath);
            
            if ('data' in command && 'execute' in command) {
                console.log(`📦 Loading command: /${command.data.name}`);
                this.commands.set(command.data.name, command);
                restCommands.push(command.data.toJSON());
            }
        }

        if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_TOKEN) {
            try {
                const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
                
                // If DEV_GUILD_ID is provided, register to that guild for INSTANT updates
                if (process.env.DEV_GUILD_ID) {
                    console.log(`⚡ Registering ${restCommands.length} commands to DEV GUILD: ${process.env.DEV_GUILD_ID}`);
                    await rest.put(
                        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DEV_GUILD_ID),
                        { body: restCommands },
                    );
                } else {
                    console.log(`🌐 Registering ${restCommands.length} commands GLOBALLY (may take 1h)...`);
                    await rest.put(
                        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
                        { body: restCommands },
                    );
                }
                console.log('✅ Commands registered successfully.');
            } catch (error) {
                console.error('❌ Error registering commands:', error);
            }
        }
    }

    private registerEvents() {
        this.client.on('interactionCreate', async (interaction: BaseInteraction) => {
            if (interaction.isChatInputCommand()) {
                const command = this.commands.get(interaction.commandName);
                if (!command) return;

                try {
                    await command.execute(interaction);
                } catch (error) {
                    console.error(error);
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
                    } else {
                        await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                    }
                }
            } else if (interaction.isButton()) {
                // Handle interactive buttons from alerts
                const [action, target] = interaction.customId.split('_');

                if (action === 'mute') {
                    // In V2, this would add the wallet to a 'muted' table per-user/guild
                    await interaction.reply({ content: `🚫 Muted alerts for \`${target}\` in this channel (Mock).`, ephemeral: true });
                } else if (action === 'stats') {
                    await interaction.reply({ content: `📊 Fetching detailed historical PnL for \`${target}\`...`, ephemeral: true });
                    // Trigger the /wallet command logic or similar embed response
                }
            }
        });
    }
}
