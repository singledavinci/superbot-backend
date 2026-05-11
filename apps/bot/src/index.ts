import { Client, GatewayIntentBits, Collection, REST, Routes, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, BaseInteraction } from 'discord.js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Worker, Job } from 'bullmq';
import { redisConnection } from '@superbot/queue';
import { prisma } from '@superbot/database';
import { registerGuildSlashCommandSync, type GuildSlashSyncResult } from './command-sync-context';
import {
    createWhaleBuyEmbed,
    createMintAlertEmbed,
    createFloorUpdateEmbed,
    createSweepEmbed,
    createMassListingEmbed,
    createMassDelistEmbed,
    createFloorMovementEmbed,
    createClusterBuyEmbed,
    createFloorImpactFollowupEmbed,
    createHotMintEmbed,
    createWalletActionBatchEmbed,
    createOpportunitySpikeEmbed,
} from './embeds';
import type { ContextualExplanation } from '@superbot/types';
import { formatFallbackCollectionName } from '@superbot/analytics';
import { links } from './links';

dotenv.config();

/** Allow only real guild roles — blocks @everyone (role id equals guild id) and bogus ids. */
async function resolvePingableRoleId(
    channel: TextChannel | null | undefined,
    roleId: string | undefined | null,
): Promise<string | undefined> {
    const id = typeof roleId === 'string' ? roleId.trim() : '';
    if (!id || !channel || !channel.isTextBased()) return undefined;
    if (!('guild' in channel) || !channel.guild) return undefined;
    try {
        const role = await channel.guild.roles.fetch(id);
        if (!role) return undefined;
        if (role.guild.id === role.id) return undefined;
        return role.id;
    } catch {
        return undefined;
    }
}

function nftMarketplaceButtons(contract: string, tokenId: string): ButtonBuilder[] {
    return [
        new ButtonBuilder()
            .setLabel('OpenSea')
            .setStyle(ButtonStyle.Link)
            .setURL(links.opensea.nft(contract, tokenId)),
        new ButtonBuilder()
            .setLabel('CatchMint')
            .setStyle(ButtonStyle.Link)
            .setURL(links.catchmint.collection(contract)),
        new ButtonBuilder()
            .setLabel('Etherscan')
            .setStyle(ButtonStyle.Link)
            .setURL(links.etherscan.nft(contract, tokenId)),
    ];
}

function collectionMarketplaceButtons(contract: string, collectionSlug?: string | null): ButtonBuilder[] {
    const slug = typeof collectionSlug === 'string' ? collectionSlug.trim() : '';
    const openSeaUrl = slug ? links.opensea.collection(slug) : links.opensea.collectionByContract(contract);
    return [
        new ButtonBuilder()
            .setLabel('OpenSea')
            .setStyle(ButtonStyle.Link)
            .setURL(openSeaUrl),
        new ButtonBuilder()
            .setLabel('CatchMint')
            .setStyle(ButtonStyle.Link)
            .setURL(links.catchmint.collection(contract)),
        new ButtonBuilder()
            .setLabel('Etherscan')
            .setStyle(ButtonStyle.Link)
            .setURL(links.etherscan.token(contract)),
    ];
}

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
        registerGuildSlashCommandSync((guildId) => this.putSlashCommandsForGuild(guildId));

        this.client.once('ready', async () => {
            await this.ensureGuildRowsForConnectedServers();
            console.log('[Bot] Contextual intelligence deterministic engine ready (embed layer).');
            const prismaIds = (await prisma.guild.findMany({ select: { discordId: true } })).map(g => g.discordId);
            const cacheIds = [...this.client.guilds.cache.keys()];
            const guildIds = [...new Set([...prismaIds, ...cacheIds])];
            console.log(`[Bot] Syncing slash commands across ${guildIds.length} guild(s) (global + per-guild)`);
            await this.syncSlashCommandsToGuilds(guildIds);
        });

        this.client.on('guildCreate', async guild => {
            console.log(`➕ Joined guild ${guild.id}; registering slash commands`);
            await this.upsertGuildRow(guild.id, guild.name);
            await this.syncSlashCommandsToGuilds([guild.id]);
        });

        this.registerEvents();

        await this.client.login(process.env.DISCORD_TOKEN);
        console.log(`[Bot] Logged in as ${this.client.user?.tag}`);

        this.startDeliveryDispatcher();
    }

    /** Ensures OAuth dashboard can intersect `@me/guilds` with Postgres even before `/setup` runs. */
    private async upsertGuildRow(discordId: string, name: string | null) {
        const label = (name && name.trim()) || 'Discord Server';
        try {
            await prisma.guild.upsert({
                where: { discordId },
                create: { discordId, name: label, planTier: 'FREE' },
                update: { name: label },
            });
        } catch (err) {
            console.warn(`[Bot] Guild upsert failed for ${discordId}:`, err);
        }
    }

    private async ensureGuildRowsForConnectedServers() {
        const tasks = [...this.client.guilds.cache.values()].map((g) => this.upsertGuildRow(g.id, g.name));
        await Promise.all(tasks);
        if (tasks.length) {
            console.log(`📇 Synced ${tasks.length} Guild row(s) from Discord`);
        }
    }

    private restErrorMeta(err: unknown): { status?: number; message: string } {
        let status: number | undefined;
        if (typeof err === 'object' && err !== null && 'status' in err) {
            const s = (err as { status: unknown }).status;
            if (typeof s === 'number') status = s;
        }
        const message = err instanceof Error ? err.message : String(err);
        return { status, message };
    }

    private async putSlashCommandsForGuild(guildId: string): Promise<GuildSlashSyncResult> {
        if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_TOKEN || !this.restCommandBodies.length) {
            return { ok: false, message: 'Missing DISCORD_CLIENT_ID, DISCORD_TOKEN, or no commands loaded.' };
        }
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        try {
            await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), {
                body: this.restCommandBodies,
            });
            return { ok: true, commandCount: this.restCommandBodies.length };
        } catch (err: unknown) {
            const { status, message } = this.restErrorMeta(err);
            return { ok: false, status, message };
        }
    }

    private async syncSlashCommandsToGuilds(guildIds: string[]) {
        if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_TOKEN || !this.restCommandBodies.length) {
            console.warn('[Bot] Missing client id/token or commands; skipping command sync.');
            return;
        }
        const clientId = process.env.DISCORD_CLIENT_ID;
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const n = this.restCommandBodies.length;

        const devGuild = process.env.DEV_GUILD_ID;
        let targets = [...new Set(guildIds)].filter(Boolean);
        if (devGuild) {
            targets = [...new Set([...targets, devGuild])];
        }

        let globalCount: number | 'FAIL' = 'FAIL';
        try {
            await rest.put(Routes.applicationCommands(clientId), { body: this.restCommandBodies });
            globalCount = n;
            console.log(`[Bot] Synced ${n} global slash commands.`);
        } catch (err: unknown) {
            const { status, message } = this.restErrorMeta(err);
            console.error(`[Bot] Global command PUT failed status=${status ?? '?'}:`, message);
        }

        let success = 0;
        let failed = 0;
        for (const gid of targets) {
            const r = await this.putSlashCommandsForGuild(gid);
            if (r.ok) {
                success++;
                console.log(`[Bot] Synced ${n} commands to guild ${gid}`);
            } else {
                failed++;
                console.error(`[Bot] Guild command PUT failed guildId=${gid} status=${r.status ?? '?'}: ${r.message ?? ''}`);
            }
        }

        console.log(`[Bot] Command sync complete. Global=${globalCount}, Guilds: success=${success}, failed=${failed}`);

        if (process.env.DISCORD_CLIENT_ID) {
            const cid = process.env.DISCORD_CLIENT_ID;
            console.log(
                `[Bot] Invite URL (bot + slash scopes): https://discord.com/oauth2/authorize?client_id=${cid}&permissions=2147485696&scope=bot%20applications.commands`
            );
        }
    }

    private startDeliveryDispatcher() {
        console.log('🚀 Starting Discord Delivery Dispatcher...');
        this.deliveryWorker = new Worker('discord_delivery', async (job: Job) => {
            if (job.name === 'discord_alert') {
                await this.dispatchAlert(job.data);
            } else if (job.name === 'floor_impact_followup') {
                await this.dispatchFloorImpactFollowup(job.data);
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

            const validatedRoleId = await resolvePingableRoleId(channel, data.mentionRoleId);
            if (validatedRoleId !== data.mentionRoleId?.trim?.() && data.mentionRoleId) {
                console.warn(
                    `[Delivery] Disabled invalid or unsafe ping role="${data.mentionRoleId}" for ${alertType} channel=${channelId}`,
                );
            }

            let content = '';
            if (validatedRoleId) {
                content = `<@&${validatedRoleId}>`;
            }

            if (alertType === 'WALLET_ACTION_BATCH') {
                const bb = String(data.batchBehavior || 'buy') as 'buy' | 'sale' | 'mint';
                const b = data.batch || {};
                const embed = createWalletActionBatchEmbed({
                    contract: data.contract,
                    chain: typeof data.chain === 'string' ? data.chain : 'ethereum',
                    collectionName:
                        typeof data.collectionName === 'string' ? data.collectionName : data.contract,
                    wallet: typeof data.wallet === 'string' ? data.wallet : '',
                    batchBehavior:
                        bb === 'sale' || bb === 'mint' || bb === 'buy' ? bb : 'buy',
                    label: data.label ?? null,
                    intelligence: data.intelligence,
                    nftMeta: data.nftMeta ?? null,
                    walletProfile: data.walletProfile ?? null,
                    batch: {
                        itemCount: Number(b.itemCount) || 0,
                        totalNative: Number(b.totalNative) || 0,
                        currency: typeof b.currency === 'string' ? b.currency : 'ETH',
                        txHashes: Array.isArray(b.txHashes) ? b.txHashes.map(String) : [],
                        blockRange:
                            b.blockRange &&
                            typeof b.blockRange.first === 'number' &&
                            typeof b.blockRange.last === 'number'
                                ? { first: b.blockRange.first, last: b.blockRange.last }
                                : { first: 0, last: 0 },
                        firstSeenAt: Number(b.firstSeenAt) || Date.now(),
                        lastSeenAt: Number(b.lastSeenAt) || Date.now(),
                        sampleTokenIds: Array.isArray(b.sampleTokenIds)
                            ? b.sampleTokenIds.map(String)
                            : [],
                        sampleNftNames: Array.isArray(b.sampleNftNames)
                            ? b.sampleNftNames.map(String)
                            : [],
                        marketplace: typeof b.marketplace === 'string' ? b.marketplace : undefined,
                        possibleWashTrading: Boolean(b.possibleWashTrading),
                    },
                });
                const firstTid =
                    Array.isArray(b.sampleTokenIds) && b.sampleTokenIds.length > 0
                        ? String(b.sampleTokenIds[0])
                        : '0';
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...nftMarketplaceButtons(data.contract, firstTid),
                    new ButtonBuilder()
                        .setCustomId(`stats_${data.wallet}`)
                        .setLabel('View Wallet Stats')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`mute_${data.wallet}`)
                        .setLabel('Mute this Wallet')
                        .setStyle(ButtonStyle.Danger),
                );
                await channel.send({
                    content,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] },
                });
            } else if (alertType === 'WHALE_BUY' || alertType === 'WHALE_SALE' || alertType === 'WHALE_MINT') {
                const embed = createWhaleBuyEmbed({
                    contract: data.contract,
                    collectionName:
                        typeof data.collectionName === 'string' && data.collectionName.trim()
                            ? data.collectionName.trim()
                            : formatFallbackCollectionName(String(data.contract || '')),
                    nftName: typeof data.nftName === 'string' && data.nftName.trim() ? data.nftName.trim() : undefined,
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
                    nftMeta: data.nftMeta ?? null,
                    walletProfile: data.walletProfile ?? null,
                    counterpartyProfile: data.counterpartyProfile ?? null,
                });
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...nftMarketplaceButtons(data.contract, String(data.tokenId)),
                    new ButtonBuilder()
                        .setCustomId(`stats_${data.wallet}`)
                        .setLabel('View Wallet Stats')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`mute_${data.wallet}`)
                        .setLabel('Mute this Wallet')
                        .setStyle(ButtonStyle.Danger),
                );

                await channel.send({ 
                    content, 
                    embeds: [embed], 
                    components: [row],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] }
                });
            } else if (alertType === 'MINT_RADAR') {
                const embed = createMintAlertEmbed({
                    contract: data.contract,
                    chain: data.chain,
                    velocity: data.velocity,
                    timeWindowMin: data.timeWindowMin,
                    collectionName:
                        typeof data.collectionName === 'string' && data.collectionName.trim()
                            ? data.collectionName.trim()
                            : formatFallbackCollectionName(String(data.contract || '')),
                    collectionMeta: data.collectionMeta ?? null,
                });
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...collectionMarketplaceButtons(data.contract, data.collectionMeta?.slug ?? null),
                );

                await channel.send({ 
                    content, 
                    embeds: [embed], 
                    components: [row],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] }
                });
            } else if (alertType === 'FLOOR_UPDATE') {
                const embed = createFloorUpdateEmbed(data);
                await channel.send({ 
                    content, 
                    embeds: [embed],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] }
                });
            } else if (alertType === 'SWEEP') {
                const embed = createSweepEmbed({
                    collectionName: data.collectionName,
                    contract: data.contract,
                    chain: data.chain,
                    buyer: data.buyer,
                    txHash: data.txHash,
                    itemCount: data.itemCount,
                    totalNative: data.totalNative,
                    currency: data.currency,
                    tokenIds: data.tokenIds,
                    collectionMeta: data.collectionMeta ?? null,
                    buyerProfile: data.buyerProfile ?? null,
                    sampleNftMetas: Array.isArray(data.sampleNftMetas) ? data.sampleNftMetas : [],
                    sampleNftNames: Array.isArray(data.sampleNftNames) ? data.sampleNftNames : undefined,
                    contextualExplanation: data.contextualExplanation ?? null,
                    aiNarrative: data.aiNarrative ?? undefined,
                });
                const sweepSlug =
                    data.collectionMeta?.slug ??
                    (Array.isArray(data.sampleNftMetas) && data.sampleNftMetas[0]?.collectionSlug) ??
                    null;
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel('Transaction')
                        .setStyle(ButtonStyle.Link)
                        .setURL(links.etherscan.tx(data.txHash)),
                    ...collectionMarketplaceButtons(data.contract, sweepSlug),
                );
                await channel.send({
                    content,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] },
                });
            } else if (alertType === 'MASS_LISTING') {
                const massSlug = data.collectionMeta?.slug ?? null;
                const embed = createMassListingEmbed({
                    collectionName: data.collectionName,
                    contract: data.contract,
                    chain: data.chain,
                    listingCount: data.listingCount,
                    windowMs: data.windowMs,
                    collectionMeta: data.collectionMeta ?? null,
                    floorBeforeEth:
                        typeof data.floorBeforeEth === 'number' && data.floorBeforeEth > 0
                            ? data.floorBeforeEth
                            : null,
                    floorImpactPending: Boolean(data.floorImpactPending),
                    contextualExplanation: data.contextualExplanation ?? null,
                    aiNarrative: data.aiNarrative ?? undefined,
                });
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...collectionMarketplaceButtons(data.contract, massSlug),
                );
                const sent = await channel.send({
                    content,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] },
                });
                if (eventId && sent?.id) {
                    try {
                        await redisConnection.set(`alert_discord_msg:${eventId}`, sent.id, 'EX', 3600);
                    } catch (e) {
                        console.warn('[Delivery] Redis alert_discord_msg set failed:', e);
                    }
                }
            } else if (alertType === 'MASS_DELIST') {
                const slug = data.collectionMeta?.slug ?? null;
                const embed = createMassDelistEmbed({
                    collectionName: data.collectionName,
                    contract: data.contract,
                    chain: data.chain,
                    delistCount: Number(data.delistCount) || 0,
                    windowMs: Number(data.windowMs) || 0,
                    sampleOrderIds: Array.isArray(data.sampleOrderIds) ? data.sampleOrderIds : [],
                    collectionMeta: data.collectionMeta ?? null,
                    floorBeforeEth:
                        typeof data.floorBeforeEth === 'number' && data.floorBeforeEth > 0
                            ? data.floorBeforeEth
                            : null,
                    floorImpactPending: Boolean(data.floorImpactPending),
                    contextualExplanation: data.contextualExplanation ?? null,
                    aiNarrative: data.aiNarrative ?? undefined,
                });
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...collectionMarketplaceButtons(data.contract, slug),
                );
                const sent = await channel.send({
                    content,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] },
                });
                if (eventId && sent?.id) {
                    try {
                        await redisConnection.set(`alert_discord_msg:${eventId}`, sent.id, 'EX', 3600);
                    } catch (e) {
                        console.warn('[Delivery] Redis alert_discord_msg set failed:', e);
                    }
                }
            } else if (alertType === 'HOT_MINT') {
                const slug = data.collectionMeta?.slug ?? null;
                const embed = createHotMintEmbed({
                    collectionName:
                        typeof data.collectionName === 'string' && data.collectionName.trim()
                            ? data.collectionName.trim()
                            : formatFallbackCollectionName(String(data.contract || '')),
                    contract: data.contract,
                    chain: data.chain || 'ethereum',
                    uniqueMinters: Number(data.uniqueMinters) || 0,
                    totalMints: Number(data.totalMints) || 0,
                    windowMinutes: Number(data.windowMinutes) || 10,
                    velocityPerMin: Number(data.velocityPerMin) || 0,
                    pctSupplyMinted:
                        data.pctSupplyMinted !== undefined && data.pctSupplyMinted !== null
                            ? Number(data.pctSupplyMinted)
                            : null,
                    floorEth:
                        typeof data.floorEth === 'number' && data.floorEth > 0 ? data.floorEth : null,
                    blockRange: String(data.blockRange || '—'),
                    topMinerLines: Array.isArray(data.topMinerLines) ? data.topMinerLines : [],
                    collectionMeta: data.collectionMeta ?? null,
                    contextualExplanation: data.contextualExplanation ?? null,
                    aiNarrative: data.aiNarrative ?? undefined,
                });
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...collectionMarketplaceButtons(data.contract, slug),
                );
                await channel.send({
                    content,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] },
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
                    contextualExplanation: data.contextualExplanation ?? null,
                    aiNarrative: data.aiNarrative ?? undefined,
                });
                await channel.send({
                    content,
                    embeds: [embed],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] },
                });
            } else if (alertType === 'OPPORTUNITY_SPIKE') {
                const slug = data.collectionMeta?.slug ?? null;
                const embed = createOpportunitySpikeEmbed({
                    collectionName:
                        typeof data.collectionName === 'string' && data.collectionName.trim()
                            ? data.collectionName.trim()
                            : formatFallbackCollectionName(String(data.contract || '')),
                    contract: String(data.contract || ''),
                    chain: typeof data.chain === 'string' ? data.chain : 'ethereum',
                    timeWindow: String(data.timeWindow || '15–60m rolling'),
                    score: Number(data.score) || 0,
                    signal: String(data.signal || '—'),
                    confidence: String(data.confidence || '—'),
                    volumeChange: String(data.volumeChange || '—'),
                    tradeCount: String(data.tradeCount || '—'),
                    uniqueBuyers: String(data.uniqueBuyers || '—'),
                    sweepActivity: String(data.sweepActivity || '—'),
                    floorChange: String(data.floorChange || '—'),
                    listingPressure: String(data.listingPressure || '—'),
                    trackedWalletActivity: String(data.trackedWalletActivity || '—'),
                    riskFlags: String(data.riskFlags || '—'),
                    dataLimitations: String(data.dataLimitations || '—'),
                    collectionMeta: data.collectionMeta ?? null,
                    contextualExplanation: data.contextualExplanation ?? null,
                    aiNarrative: data.aiNarrative ?? undefined,
                });
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...collectionMarketplaceButtons(String(data.contract || ''), slug),
                );
                await channel.send({
                    content,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] },
                });
            } else if (alertType === 'CLUSTER_BUY') {
                const triggerTxHash = String(data.triggerTxHash || data.txHash || '');
                const embed = createClusterBuyEmbed({
                    collectionName:
                        typeof data.collectionName === 'string' && data.collectionName.trim()
                            ? data.collectionName.trim()
                            : formatFallbackCollectionName(String(data.contract || '')),
                    contract: data.contract,
                    chain: data.chain || 'ethereum',
                    wallets: Array.isArray(data.wallets) ? data.wallets : [],
                    windowMinutes: Number(data.windowMinutes) || 30,
                    triggerTxHash,
                    triggerBuyer: data.triggerBuyer || '',
                    collectionMeta: data.collectionMeta ?? null,
                    triggerProfile: data.triggerProfile ?? null,
                    nftName: typeof data.nftName === 'string' && data.nftName.trim() ? data.nftName.trim() : undefined,
                    triggerTokenId:
                        typeof data.triggerTokenId === 'string' && data.triggerTokenId.trim()
                            ? data.triggerTokenId.trim()
                            : undefined,
                    contextualExplanation: data.contextualExplanation ?? null,
                    aiNarrative: data.aiNarrative ?? undefined,
                });
                const slug = data.collectionMeta?.slug ?? null;
                const marketplaceRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...collectionMarketplaceButtons(data.contract, slug),
                );
                const components: ActionRowBuilder<ButtonBuilder>[] = [];
                if (/^0x[a-fA-F0-9]{64}$/.test(triggerTxHash)) {
                    components.push(
                        new ActionRowBuilder<ButtonBuilder>().addComponents(
                            new ButtonBuilder()
                                .setLabel('Trigger transaction')
                                .setStyle(ButtonStyle.Link)
                                .setURL(links.etherscan.tx(triggerTxHash)),
                        ),
                    );
                }
                components.push(marketplaceRow);
                await channel.send({
                    content,
                    embeds: [embed],
                    components,
                    allowedMentions: { roles: validatedRoleId ? [validatedRoleId] : [] },
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

    private async dispatchFloorImpactFollowup(data: {
        deliveryKey: string;
        eventId: string;
        channelId: string;
        contract: string;
        collectionName?: string;
        replyToMessageId: string;
        alertType: 'MASS_LISTING' | 'MASS_DELIST';
        floorBefore: number | null;
        floorAfter: number | null;
        pctChange: number | null;
        contextualExplanation?: ContextualExplanation | null;
        aiNarrative?: string;
        mentionRoleId?: string | null;
    }) {
        const deliveryKey = data.deliveryKey;
        const eventId = data.eventId;
        const channelId = data.channelId;
        const alertType = 'FLOOR_IMPACT_FOLLOWUP';

        try {
            const existing = await prisma.alertDeliveryLog.findUnique({ where: { deliveryKey } });
            if (existing && existing.status === 'delivered') {
                console.log(`[Delivery] Skipping duplicate floor follow-up (${deliveryKey}).`);
                return;
            }
        } catch (err) {
            console.warn('[Delivery] AlertDeliveryLog lookup failed (floor follow-up); proceeding.', err);
        }

        try {
            const channel = await this.client.channels.fetch(data.channelId) as TextChannel;
            if (!channel || !channel.isTextBased()) {
                await this.recordDelivery(
                    deliveryKey,
                    eventId,
                    channelId,
                    alertType,
                    'failed',
                    'channel_not_text',
                );
                return;
            }

            const embed = createFloorImpactFollowupEmbed({
                alertType: data.alertType,
                contract: data.contract,
                collectionName:
                    typeof data.collectionName === 'string' && data.collectionName.trim()
                        ? data.collectionName.trim()
                        : formatFallbackCollectionName(String(data.contract || '')),
                floorBefore: data.floorBefore,
                floorAfter: data.floorAfter,
                pctChange: data.pctChange,
                contextualExplanation: data.contextualExplanation ?? null,
                aiNarrative: data.aiNarrative ?? undefined,
            });

            const orig = await channel.messages.fetch(data.replyToMessageId);
            const replyCh =
                orig.channel && orig.channel.isTextBased() ? (orig.channel as TextChannel) : null;
            const validatedFollowRole = await resolvePingableRoleId(replyCh, data.mentionRoleId);
            const followContent = validatedFollowRole ? `<@&${validatedFollowRole}>` : undefined;
            await orig.reply({
                ...(followContent ? { content: followContent } : {}),
                embeds: [embed],
                allowedMentions: validatedFollowRole
                    ? { roles: [validatedFollowRole] }
                    : { parse: [] },
            });

            await this.recordDelivery(deliveryKey, eventId, channelId, alertType, 'delivered');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[Delivery] Floor follow-up failed channel=${data.channelId}:`, message);
            await this.recordDelivery(
                deliveryKey,
                eventId,
                channelId,
                alertType,
                'failed',
                message.slice(0, 500),
            );
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

        const execMintInIntel = process.env.MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS === 'true';
        const commandFiles = fs.readdirSync(commandsPath).filter(file => {
            if (!(file.endsWith('.ts') || file.endsWith('.js')) || file.endsWith('.d.ts')) return false;
            if (file.startsWith('mint-') && !execMintInIntel) return false;
            return true;
        });
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
                if (interaction.customId.startsWith('togglerole:')) {
                    const roleId = interaction.customId.slice('togglerole:'.length).trim();
                    if (!/^\d{17,22}$/.test(roleId)) {
                        await interaction.reply({ content: 'Invalid role control.', ephemeral: true });
                        return;
                    }
                    if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) {
                        await interaction.reply({ content: 'Use this inside a server.', ephemeral: true });
                        return;
                    }
                    try {
                        const [member, role] = await Promise.all([
                            interaction.guild.members.fetch(interaction.user.id),
                            interaction.guild.roles.fetch(roleId),
                        ]);
                        if (!role) {
                            await interaction.reply({
                                content: 'That role no longer exists.',
                                ephemeral: true,
                            });
                            return;
                        }
                        const guildRow = await prisma.guild.findUnique({
                            where: { discordId: interaction.guildId },
                            select: {
                                alertChannels: {
                                    where: { mentionRoleId: roleId },
                                    select: { discordChannelId: true },
                                    take: 1,
                                },
                            },
                        });
                        const pingCh = guildRow?.alertChannels[0]?.discordChannelId;
                        const chFrag = pingCh ? `<#${pingCh}>` : 'the alert channel';
                        const had = member.roles.cache.has(roleId);
                        if (had) {
                            await member.roles.remove(roleId);
                            await interaction.reply({
                                content: `Removed **${role.name}** — you won't be pinged for these anymore.`,
                                ephemeral: true,
                            });
                        } else {
                            await member.roles.add(roleId);
                            await interaction.reply({
                                content: `Added **${role.name}** — you'll be pinged in ${chFrag} when alerts fire.`,
                                ephemeral: true,
                            });
                        }
                    } catch (error: unknown) {
                        const code =
                            typeof error === 'object' &&
                            error !== null &&
                            'code' in error &&
                            typeof (error as { code: unknown }).code === 'number'
                                ? (error as { code: number }).code
                                : undefined;
                        if (code === 50013) {
                            await interaction.reply({
                                content:
                                    'I could not change your roles. The bot needs **Manage Roles**, and the alert role must be **below** SuperBot\'s top role in Server Settings → Roles.',
                                ephemeral: true,
                            });
                            return;
                        }
                        console.error('[Bot] togglerole interaction failed:', error);
                        const msg =
                            error instanceof Error ? error.message : 'Something went wrong. Try again later.';
                        if (interaction.replied || interaction.deferred) {
                            await interaction.followUp({ content: msg, ephemeral: true });
                        } else {
                            await interaction.reply({ content: msg, ephemeral: true });
                        }
                    }
                    return;
                }

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
