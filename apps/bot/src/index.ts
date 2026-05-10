import { Client, GatewayIntentBits, Collection, REST, Routes, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, BaseInteraction } from 'discord.js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Worker, Job } from 'bullmq';
import { redisConnection } from '@superbot/queue';
import { prisma } from '@superbot/database';
import {
    createWhaleBuyEmbed,
    createMintAlertEmbed,
    createFloorUpdateEmbed,
    createSweepEmbed,
    createMassListingEmbed,
    createFloorMovementEmbed,
    createClusterBuyEmbed,
} from './embeds';

dotenv.config();

export class SuperBot {
    public client: Client;
    public commands: Collection<string, any>;
    private deliveryWorker: Worker | null = null;
    /** Serialized slash command bodies for per-guild registration. */
    private restCommandBodies: object[] = [];

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

        this.client.once('ready', async () => {
            const prismaIds = (await prisma.guild.findMany({ select: { discordId: true } })).map(g => g.discordId);
            const cacheIds = [...this.client.guilds.cache.keys()];
            const guildIds = [...new Set([...prismaIds, ...cacheIds])];
            console.log(`🔧 Syncing slash commands across ${guildIds.length} guild(s) (instant per-guild rollout)`);
            await this.syncSlashCommandsToGuilds(guildIds);
        });

        this.client.on('guildCreate', async guild => {
            console.log(`➕ Joined guild ${guild.id}; registering slash commands`);
            await this.syncSlashCommandsToGuilds([guild.id]);
        });

        this.registerEvents();

        await this.client.login(process.env.DISCORD_TOKEN);
        console.log(`🤖 Bot logged in as ${this.client.user?.tag}`);

        this.startDeliveryDispatcher();
    }

    private async syncSlashCommandsToGuilds(guildIds: string[]) {
        if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_TOKEN || !this.restCommandBodies.length) {
            console.warn('[Bot] Missing client id/token or commands; skipping guild command sync.');
            return;
        }
        const clientId = process.env.DISCORD_CLIENT_ID;
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

        const devGuild = process.env.DEV_GUILD_ID;
        let targets = [...new Set(guildIds)].filter(Boolean);
        if (devGuild) {
            targets = [...new Set([...targets, devGuild])];
        }

        if (targets.length === 0) return;

        try {
            await rest.put(Routes.applicationCommands(clientId), { body: [] });
            console.log('🧹 Cleared global slash commands (guild-scoped registration only).');
        } catch (err) {
            console.warn('[Bot] Could not clear global commands (non-fatal):', err);
        }

        for (const gid of targets) {
            try {
                await rest.put(Routes.applicationGuildCommands(clientId, gid), {
                    body: this.restCommandBodies,
                });
            } catch (err) {
                console.error(`❌ Slash command PUT failed for guild ${gid}`, err);
            }
        }
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
        const eventId: string | undefined = data.eventId || data.txHash;
        const channelId: string | undefined = data.channelId;
        const alertType: string = data.alertType || 'UNKNOWN';
        const deliveryKey = eventId && channelId ? `${alertType}:${eventId}:${channelId}` : null;

        // Idempotency: skip if we already delivered this (eventId, channelId).
        if (deliveryKey) {
            try {
                const existing = await prisma.alertDeliveryLog.findUnique({ where: { deliveryKey } });
                if (existing && existing.status === 'delivered') {
                    console.log(`[Delivery] Skipping duplicate alert (${deliveryKey}).`);
                    return;
                }
            } catch (err) {
                console.warn('[Delivery] AlertDeliveryLog lookup failed; proceeding without dedupe.', err);
            }
        }

        try {
            const channel = await this.client.channels.fetch(data.channelId) as TextChannel;
            if (!channel || !channel.isTextBased()) {
                if (deliveryKey) {
                    await this.recordDelivery(deliveryKey, eventId!, channelId!, alertType, 'failed', 'channel_not_text');
                }
                return;
            }

            let content = '';
            if (data.mentionRoleId) {
                content = `<@&${data.mentionRoleId}>`;
            }

            if (alertType === 'WHALE_BUY' || alertType === 'WHALE_SALE' || alertType === 'WHALE_MINT') {
                const embed = createWhaleBuyEmbed({
                    contract: data.contract,
                    wallet: data.wallet,
                    tokenId: data.tokenId,
                    txHash: data.txHash,
                    alertType: data.alertType,
                    price: data.price,
                    currency: data.currency,
                    marketplace: data.marketplace,
                    label: data.label,
                    intelligence: data.intelligence,
                    possibleWashTrading: Boolean(data.possibleWashTrading),
                });
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

                await channel.send({ 
                    content, 
                    embeds: [embed], 
                    components: [row],
                    allowedMentions: { roles: data.mentionRoleId ? [data.mentionRoleId] : [] }
                });
            } else if (alertType === 'MINT_RADAR') {
                const embed = createMintAlertEmbed(data);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel('View Contract')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://etherscan.io/address/${data.contract}`)
                );

                await channel.send({ 
                    content, 
                    embeds: [embed], 
                    components: [row],
                    allowedMentions: { roles: data.mentionRoleId ? [data.mentionRoleId] : [] }
                });
            } else if (alertType === 'FLOOR_UPDATE') {
                const embed = createFloorUpdateEmbed(data);
                await channel.send({ 
                    content, 
                    embeds: [embed],
                    allowedMentions: { roles: data.mentionRoleId ? [data.mentionRoleId] : [] }
                });
            } else if (alertType === 'SWEEP') {
                const embed = createSweepEmbed(data);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel('Transaction')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://etherscan.io/tx/${data.txHash}`),
                    new ButtonBuilder()
                        .setLabel('Collection')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://blur.io/collection/${data.contract}`),
                );
                await channel.send({
                    content,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { roles: data.mentionRoleId ? [data.mentionRoleId] : [] },
                });
            } else if (alertType === 'MASS_LISTING') {
                const embed = createMassListingEmbed(data);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel('Contract')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://etherscan.io/address/${data.contract}`),
                );
                await channel.send({
                    content,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { roles: data.mentionRoleId ? [data.mentionRoleId] : [] },
                });
            } else if (alertType === 'FLOOR_DROP' || alertType === 'FLOOR_RISE') {
                const embed = createFloorMovementEmbed({
                    collectionName: data.collectionName,
                    contract: data.contract,
                    floorPrice: data.floorPrice,
                    prevFloor: data.prevFloor,
                    pctChange: data.pctChange,
                    currency: data.currency,
                    direction: alertType === 'FLOOR_DROP' ? 'drop' : 'rise',
                });
                await channel.send({
                    content,
                    embeds: [embed],
                    allowedMentions: { roles: data.mentionRoleId ? [data.mentionRoleId] : [] },
                });
            } else if (alertType === 'CLUSTER_BUY') {
                const triggerTxHash = String(data.triggerTxHash || data.txHash || '');
                const embed = createClusterBuyEmbed({
                    collectionName: data.collectionName || data.contract,
                    contract: data.contract,
                    chain: data.chain || 'ethereum',
                    wallets: Array.isArray(data.wallets) ? data.wallets : [],
                    windowMinutes: Number(data.windowMinutes) || 30,
                    triggerTxHash,
                    triggerBuyer: data.triggerBuyer || '',
                });
                const components =
                    /^0x[a-fA-F0-9]{64}$/.test(triggerTxHash)
                        ? [
                              new ActionRowBuilder<ButtonBuilder>().addComponents(
                                  new ButtonBuilder()
                                      .setLabel('Trigger transaction')
                                      .setStyle(ButtonStyle.Link)
                                      .setURL(`https://etherscan.io/tx/${triggerTxHash}`),
                              ),
                          ]
                        : [];
                await channel.send({
                    content,
                    embeds: [embed],
                    components,
                    allowedMentions: { roles: data.mentionRoleId ? [data.mentionRoleId] : [] },
                });
            }

            if (deliveryKey) {
                await this.recordDelivery(deliveryKey, eventId!, channelId!, alertType, 'delivered');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[Delivery] Failed to dispatch alert to channel ${data.channelId}:`, message);
            if (deliveryKey && eventId && channelId) {
                await this.recordDelivery(deliveryKey, eventId, channelId, alertType, 'failed', message.slice(0, 500));
            }
        }
    }

    private async recordDelivery(
        deliveryKey: string,
        eventId: string,
        channelId: string,
        alertType: string,
        status: 'delivered' | 'failed' | 'skipped_duplicate',
        error?: string
    ) {
        try {
            await prisma.alertDeliveryLog.upsert({
                where: { deliveryKey },
                create: { deliveryKey, eventId, channelId, alertType, status, error },
                update: { status, error }
            });
        } catch (err) {
            console.warn('[Delivery] Failed to record AlertDeliveryLog entry:', err);
        }
    }

    private async loadCommands() {
        const commandsPath = path.join(__dirname, 'commands');
        console.log(`[Debug] Looking for commands in: ${commandsPath}`);
        
        if (!fs.existsSync(commandsPath)) {
            console.error(`[Debug] Commands path NOT FOUND: ${commandsPath}`);
            return;
        }

        const commandFiles = fs.readdirSync(commandsPath).filter(file => 
            (file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts')
        );
        console.log(`[Debug] Found ${commandFiles.length} potential command files.`);

        const restCommands = [];

        for (const file of commandFiles) {
            try {
                const filePath = path.join(commandsPath, file);
                const command = await import(filePath);
                
                if ('data' in command && 'execute' in command) {
                    console.log(`📦 Loading command: /${command.data.name}`);
                    this.commands.set(command.data.name, command);
                    restCommands.push(command.data.toJSON());
                } else {
                    console.warn(`[Debug] Skipping file ${file}: Missing data or execute.`);
                }
            } catch (err) {
                console.error(`[Debug] Failed to load command file ${file}:`, err);
            }
        }

        this.restCommandBodies = restCommands;
        console.log(`📋 Loaded ${restCommands.length} slash command bodies (per-guild sync after ready).`);
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

if (require.main === module) {
    const bot = new SuperBot();
    bot.start().catch(err => {
        console.error('❌ Failed to start SuperBot:', err);
        process.exit(1);
    });
}
