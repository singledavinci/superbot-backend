import { Worker, Job } from 'bullmq';
import { redisConnection, discordQueue as discordDeliveryQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import {
    clickhouse,
    SweepDetector,
    SmartMoneyClusterDetector,
    NFTMetadataClient,
    WalletProfileClient,
    HotMintDetector,
    OpenSeaSalesClient,
    createRpcPoolFromEnv,
    resolveHttpRpcUrl,
    RpcPool,
    CollectionNameResolver,
    isPlaceholderCollectionName,
    formatFallbackCollectionName,
    type NormalizedSale,
    type SweepDetection,
    type ClusterBuyDetection,
    type NFTMetadata,
    type WalletProfile,
    type HotMintDetection,
} from '@superbot/analytics';
import { SniperEngine } from '@superbot/utils';
import {
    SaleDetector,
    explainWhale,
    contextualToIntelligenceReport,
    summarizeFactsWithOptionalAi,
    explainSweep,
    explainClusterBuy,
    explainHotMint,
    explainFloorImpactFollowup,
    type WhaleContextMetrics,
} from '@superbot/intelligence';
import type { JsonRpcProvider } from 'ethers';
import type { IntelligenceReport } from '@superbot/types';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function shortEthAddr(addr: string): string {
    if (!addr) return '—';
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export class EventWorker {
    private snipers = new Map<string, SniperEngine>();
    private sweepDetector = new SweepDetector();
    private clusterDetector = new SmartMoneyClusterDetector();
    private saleDetectors = new Map<string, SaleDetector>();
    private profileCache = new Map<string, { profile: any, timestamp: number }>();
    private CACHE_TTL = 10 * 60 * 1000; // 10 minutes
    private SNIPING_ENABLED = false; // Hard-disabled for security per audit

    /**
     * Per-NFT and per-wallet enrichment used to decorate Discord alert embeds.
     * Both clients are best-effort and never throw — failed lookups degrade the
     * embed instead of blocking the alert.
     */
    private nftMetadata = new NFTMetadataClient({ redis: redisConnection });
    private walletProfiles = new WalletProfileClient({ redis: redisConnection });
    private hotMintDetector = new HotMintDetector();
    private openSeaFloor = new OpenSeaSalesClient();
    private rpcPool: RpcPool | null = null;
    private collectionNames!: CollectionNameResolver;

    /** Sliding window for correlated tracked-wallet intel (default 60 minutes). */
    private INTEL_WINDOW_MS =
        Number(process.env.INTEL_ACTIVITY_WINDOW_MS) > 0
            ? Number(process.env.INTEL_ACTIVITY_WINDOW_MS)
            : 60 * 60 * 1000;

    constructor() {
        // Ethereum-only deployment. Re-add other chains here together with their
        // *_WSS_RPC_URL env vars when expanding multi-chain support.
        this.rpcPool = createRpcPoolFromEnv();
        if (this.rpcPool && this.rpcPool.httpsUrls.length > 0) {
            const pooled = {
                getHttpsProvider: () => this.rpcPool!.getHttpsProvider(),
                markHttpsSuccess: (p: JsonRpcProvider) => this.rpcPool!.markHttpsSuccess(p),
                markHttps429: (p: JsonRpcProvider) => this.rpcPool!.markHttps429(p),
            };
            this.saleDetectors.set('ethereum', new SaleDetector(pooled));
        } else {
            const ethHttpUrl = resolveHttpRpcUrl('WSS_RPC_URL', 'HTTPS_RPC_URL');
            if (ethHttpUrl) {
                this.saleDetectors.set('ethereum', new SaleDetector(ethHttpUrl));
            } else {
                console.warn('[Worker] No Ethereum RPC URL configured; sale detection will be disabled.');
            }
        }

        this.collectionNames = new CollectionNameResolver({
            redis: redisConnection,
            nftMetadata: this.nftMetadata,
            rpcPool:
                this.rpcPool && this.rpcPool.httpsUrls.length > 0 ? this.rpcPool : null,
        });

        console.log('[Worker] HotMintDetector initialized (Ethereum, tracked collections).');
    }

    public async start() {
        console.log('👷 Event Worker started. Processing high-velocity NFT events...');
        console.log('[Worker] Contextual intelligence deterministic layer online (deterministic explanations; optional AI).');

        // Match the queue published by the indexer (`packages/queue` exports `eventQueue` -> 'blockchain_events').
        const worker = new Worker('blockchain_events', async (job: Job) => {
            const { type, chain, contract, from, to, tokenId, txHash, eventId } = job.data;

            // Indexer emits 'erc721_transfer' or 'erc1155_transfer'; treat both as transfers.
            if (type === 'erc721_transfer' || type === 'erc1155_transfer' || type === 'transfer') {
                await this.handleTransfer(chain, contract, from, to, tokenId, txHash, eventId, job.data);

                // Detect mint surges for trending mint radar
                if (from === '0x0000000000000000000000000000000000000000') {
                    await this.handleMintRadar(chain, contract);
                }
            } else if (type === 'mint_radar') {
                await this.handleMintRadar(chain, contract);
            }
        }, { 
            connection: redisConnection,
            concurrency: 5
        });

        worker.on('failed', (job, err) => {
            console.error(`❌ Job ${job?.id} failed:`, err);
        });

        const floorWorker = new Worker(
            'floor_impact',
            async (job: Job) => {
                await this.handleFloorImpactJob(job.data);
            },
            { connection: redisConnection, concurrency: 2 },
        );
        floorWorker.on('failed', (job, err) => {
            console.error(`❌ floor_impact job ${job?.id} failed:`, err);
        });
    }

    private async readFloorNativeCachedOrOpenSea(chain: string, contract: string): Promise<number | null> {
        const ch = (chain || 'ethereum').toLowerCase();
        const c = contract.toLowerCase();
        try {
            const raw = await redisConnection.get(`floor:${ch}:${c}`);
            if (raw) {
                const j = JSON.parse(raw) as { priceNative?: number };
                if (typeof j.priceNative === 'number' && j.priceNative > 0) return j.priceNative;
            }
        } catch {
            /* ignore parse errors */
        }

        if (!this.openSeaFloor.isConfigured()) return null;
        try {
            const floor = await Promise.race([
                this.openSeaFloor.fetchFloor({ contract: c, chain: ch }),
                new Promise<null>(r => setTimeout(() => r(null), 16_000)),
            ]);
            return floor && typeof floor.priceNative === 'number' && floor.priceNative > 0
                ? floor.priceNative
                : null;
        } catch {
            return null;
        }
    }

    private whaleIntelZKey(kind: 'buy' | 'sell' | 'mint', guildId: string, contractLc: string): string {
        return `intel:z:${kind}:${guildId}:${contractLc}`;
    }

    private async intelWindowDistinct(
        key: string,
        nowMs: number,
    ): Promise<{ distinct: number; events: number }> {
        const minScore = nowMs - this.INTEL_WINDOW_MS;
        try {
            const members = await redisConnection.zrangebyscore(key, String(minScore), '+inf');
            const wallets = new Set<string>();
            for (const entry of members) {
                const m = String(entry).split(':')[0]?.toLowerCase();
                if (m) wallets.add(m);
            }
            return { distinct: wallets.size, events: members.length };
        } catch (err) {
            console.warn('[Worker] intelWindowDistinct failed:', err);
            return { distinct: 0, events: 0 };
        }
    }

    private async intelWindowRegister(key: string, nowMs: number, member: string): Promise<void> {
        try {
            await redisConnection.zadd(key, nowMs, member);
            await redisConnection.zremrangebyscore(key, 0, nowMs - this.INTEL_WINDOW_MS);
        } catch (err) {
            console.warn('[Worker] intelWindowRegister failed:', err);
        }
    }

    private async floorVsSnapshotPct(
        chainLc: string,
        contractLc: string,
        floorNow: number | null,
    ): Promise<number | null> {
        if (floorNow === null || floorNow <= 0) return null;
        try {
            const snapRaw = await redisConnection.get(`floor_snapshot:${chainLc}:${contractLc}`);
            if (!snapRaw) return null;
            const snap = JSON.parse(snapRaw) as { priceNative?: number };
            const prev = snap.priceNative;
            if (typeof prev !== 'number' || !(prev > 0)) return null;
            return ((floorNow - prev) / prev) * 100;
        } catch {
            return null;
        }
    }

    private async handleFloorImpactJob(data: {
        originalEventId: string;
        channelId: string;
        alertType: 'MASS_LISTING' | 'MASS_DELIST';
        contract: string;
        chain: string;
        floorBefore: number | null;
    }) {
        const originalEventId = String(data.originalEventId || '');
        const channelId = String(data.channelId || '');
        const contract = (data.contract || '').toLowerCase();
        const chain = (data.chain || 'ethereum').toLowerCase();
        if (!originalEventId || !channelId || !contract) return;

        const floorBeforeRaw = data.floorBefore;
        const floorBefore =
            typeof floorBeforeRaw === 'number' && floorBeforeRaw > 0 ? floorBeforeRaw : null;

        let replyToMessageId: string | undefined;
        try {
            const v = await redisConnection.get(`alert_discord_msg:${originalEventId}`);
            replyToMessageId = v || undefined;
        } catch (err) {
            console.warn('[Worker] Redis alert_discord_msg get failed:', err);
        }

        if (!replyToMessageId) {
            console.warn(
                `[Worker] Floor impact skipped (no Discord message id for ${originalEventId}).`,
            );
            return;
        }

        const floorAfter = await this.readFloorNativeCachedOrOpenSea(chain, contract);

        const { name: floorImpactCollectionName } = await this.collectionNames.resolve(contract, {});

        let pctChange: number | null = null;
        if (
            floorBefore !== null &&
            floorBefore > 0 &&
            floorAfter !== null &&
            floorAfter > 0
        ) {
            pctChange = ((floorAfter - floorBefore) / floorBefore) * 100;
        }

        const deliveryKey = `FLOOR_IMPACT_FOLLOWUP:${originalEventId}:${channelId}`;

        const cxImpact = explainFloorImpactFollowup({
            originalAlertType: data.alertType,
            floorBefore,
            floorAfter,
            pctChange,
        });
        const impactNarrative = await summarizeFactsWithOptionalAi({
            explanation: cxImpact,
            jobCacheKey: deliveryKey,
        });

        await discordDeliveryQueue.add(
            'floor_impact_followup',
            {
                deliveryKey,
                eventId: originalEventId,
                channelId,
                contract,
                collectionName: floorImpactCollectionName,
                replyToMessageId,
                alertType: data.alertType,
                floorBefore,
                floorAfter: floorAfter !== null ? floorAfter : null,
                pctChange,
                contextualExplanation: cxImpact,
                aiNarrative: impactNarrative ?? undefined,
            },
            {
                jobId: `floor-followup-discord:${originalEventId}:${channelId}`,
                removeOnComplete: { age: 3600 },
                removeOnFail: { age: 86400 },
            },
        );
    }

    /** Best-effort pairwise link for wash-trade hints (30d TTL); never throws. */
    private async recordWashGraphEdge(walletA: string, walletB: string) {
        const a = walletA.toLowerCase();
        const b = walletB.toLowerCase();
        if (!a || !b || a === ZERO_ADDR || b === ZERO_ADDR) return;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        try {
            await redisConnection.set(`wash_pair:${lo}:${hi}`, '1', 'EX', 30 * 24 * 3600);
        } catch (err) {
            console.warn('[Worker] wash graph redis set failed:', err);
        }
    }

    private async recentWashPair(buyer: string, seller: string): Promise<boolean> {
        const a = buyer.toLowerCase();
        const b = seller.toLowerCase();
        if (a === b) return false;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        try {
            const v = await redisConnection.get(`wash_pair:${lo}:${hi}`);
            return v === '1';
        } catch {
            return false;
        }
    }

    private async handleTransfer(
        chain: string,
        contract: string,
        from: string,
        to: string,
        tokenId: string,
        txHash: string,
        eventId: string,
        rawJob: Record<string, unknown>,
    ) {
        await this.recordWashGraphEdge(from, to);

        const jobPriceNative =
            typeof rawJob.priceNative === 'number'
                ? rawJob.priceNative
                : rawJob.priceNative != null
                  ? Number(rawJob.priceNative)
                  : undefined;
        const jobCurrency = typeof rawJob.currency === 'string' ? rawJob.currency : undefined;
        const jobMarketplace = typeof rawJob.marketplace === 'string' ? rawJob.marketplace : undefined;
        const jobTs =
            typeof rawJob.timestamp === 'number'
                ? rawJob.timestamp
                : rawJob.timestamp != null
                  ? Number(rawJob.timestamp)
                  : undefined;
        const jobBlock =
            typeof rawJob.blockNumber === 'number'
                ? rawJob.blockNumber
                : rawJob.blockNumber != null
                  ? Number(rawJob.blockNumber)
                  : undefined;

        const trackedCollections = await prisma.trackedCollection.findMany({
            where: {
                chain: 'ethereum',
                contractAddress: { equals: contract, mode: 'insensitive' },
            },
        });

        const fromLc = typeof from === 'string' ? from.toLowerCase() : '';
        const chainLc = (chain || 'ethereum').toLowerCase();
        if (
            fromLc === ZERO_ADDR &&
            chainLc === 'ethereum' &&
            trackedCollections.length > 0 &&
            typeof to === 'string' &&
            to.trim().length > 0
        ) {
            const tsMs =
                jobTs !== undefined && jobTs > 0
                    ? jobTs > 1e12
                      ? jobTs
                      : jobTs * 1000
                    : Date.now();
            const hotDet = this.hotMintDetector.ingest({
                chain: chainLc,
                contract: contract.toLowerCase(),
                minter: to.toLowerCase(),
                blockNumber: jobBlock !== undefined && jobBlock > 0 ? jobBlock : undefined,
                tsMs,
            });
            if (hotDet) {
                await this.dispatchHotMint(hotDet, trackedCollections);
            }
        }

        const trackedBuyers = await prisma.trackedWallet.findMany({
            where: { address: { equals: to, mode: 'insensitive' } },
        });

        const trackedSellers = await prisma.trackedWallet.findMany({
            where: { address: { equals: from, mode: 'insensitive' } },
        });

        if (
            trackedCollections.length === 0 &&
            trackedBuyers.length === 0 &&
            trackedSellers.length === 0
        ) {
            return;
        }

        // Detect Event Type: MINT, SALE, or TRANSFER
        let eventType = 'TRANSFER';
        let price = '0';
        let currency = jobCurrency || 'ETH';
        let marketplace = jobMarketplace || '';

        if (from === '0x0000000000000000000000000000000000000000') {
            eventType = 'MINT';
        } else {
            const detector = this.saleDetectors.get(chain);
            if (detector) {
                const saleInfo = await detector.detectSale(txHash);
                if (saleInfo.isSale) {
                    eventType = 'SALE';
                    price = saleInfo.price || '0';
                    currency = saleInfo.currency || 'ETH';
                    marketplace = saleInfo.marketplace || 'Unknown';
                }
            }
        }

        const effectivePriceEth =
            parseFloat(price) > 0 ? parseFloat(price) : jobPriceNative && jobPriceNative > 0 ? jobPriceNative : 0;

        if (effectivePriceEth > 0 && from !== '0x0000000000000000000000000000000000000000') {
            const normalized: NormalizedSale = {
                eventId: eventId || `${txHash}:${tokenId}`,
                chain: chain || 'ethereum',
                contract: contract.toLowerCase(),
                tokenId,
                txHash,
                blockNumber: jobBlock,
                timestamp: jobTs && jobTs > 0 ? jobTs : Math.floor(Date.now() / 1000),
                buyer: to.toLowerCase(),
                seller: from.toLowerCase(),
                priceNative: effectivePriceEth,
                currency,
                marketplace: marketplace || jobMarketplace || 'unknown',
                raw: rawJob,
            };

            const sweep = this.sweepDetector.ingest(normalized);
            if (sweep && trackedCollections.length > 0) {
                await this.dispatchSweep(sweep, trackedCollections);
            }

            const seenClusterGuilds = new Set<string>();
            for (const w of trackedBuyers) {
                if (seenClusterGuilds.has(w.guildId)) continue;
                seenClusterGuilds.add(w.guildId);
                const cluster = this.clusterDetector.ingest(normalized, w.guildId);
                if (cluster) {
                    await this.dispatchClusterBuy(cluster);
                }
            }
        }

        if (trackedBuyers.length === 0 && trackedSellers.length === 0) return;

        if (from !== '0x0000000000000000000000000000000000000000' && eventType !== 'SALE' && effectivePriceEth > 0) {
            eventType = 'SALE';
            price = String(effectivePriceEth);
        }

        const tsMillis =
            jobTs !== undefined && jobTs > 0
                ? jobTs > 1e12
                  ? jobTs
                  : jobTs * 1000
                : Date.now();

        // 3. Analytics Persistence (ClickHouse)
        try {
            await clickhouse.insert({
                table: 'superbot_analytics.whale_trades',
                values: [
                    {
                        timestamp: new Date(tsMillis),
                        chain,
                        contract,
                        whale_address: eventType === 'SALE' ? (price === '0' ? from : to) : to,
                        trade_type: eventType,
                        usd_value: 0,
                        tx_hash: txHash,
                    },
                ],
                format: 'JSONEachRow',
            });
        } catch (err) {
            console.error('[Worker] ClickHouse insert failed:', err);
        }

        // 4. Alert Delivery — route each wallet alert to that wallet's channel (same as `/track-wallet`),
        // falling back to the guild's default WHALE_BUY channel from `/setup`. BullMQ jobId must include
        // `channelId` so multiple routes never dedupe each other.
        const combinedTracked = [...trackedBuyers, ...trackedSellers];
        const uniqueGuildIds = new Set(combinedTracked.map(t => t.guildId));

        let possibleWashTrading = false;
        if (
            eventType === 'SALE' &&
            from !== ZERO_ADDR &&
            (trackedBuyers.length > 0 || trackedSellers.length > 0)
        ) {
            possibleWashTrading = await this.recentWashPair(to, from);
        }

        // Enrich the NFT once per (contract, tokenId) and the buyer/seller
        // wallets once each — Promise.all keeps total enrichment latency at the
        // slowest single call (~2s typical, 4s timeout).
        const enrichmentStart = Date.now();
        const [nftMeta, buyerProfile, sellerProfile] = await Promise.all([
            this.safeFetchNFT(chain, contract, tokenId),
            this.safeFetchWallet(to),
            from && from !== ZERO_ADDR ? this.safeFetchWallet(from) : Promise.resolve(null),
        ]);
        const enrichmentMs = Date.now() - enrichmentStart;
        if (enrichmentMs > 1500) {
            console.log(
                `[Worker] Enrichment took ${enrichmentMs}ms for ${contract}:${tokenId} (buyer=${to})`,
            );
        }

        const contractLcEff = contract.toLowerCase();
        const floorIntel = await this.readFloorNativeCachedOrOpenSea(chainLc, contractLcEff);
        const floorPctIntel = await this.floorVsSnapshotPct(chainLc, contractLcEff, floorIntel);
        let listingSurgeSuspectedFlag = false;
        try {
            listingSurgeSuspectedFlag =
                (await redisConnection.get(`intel:listing_surge:${contractLcEff}`)) === '1';
        } catch {
            listingSurgeSuspectedFlag = false;
        }

        const whaleNamesByGuild = new Map<string, string>();
        if (combinedTracked.length > 0 && uniqueGuildIds.size > 0) {
            for (const gid of uniqueGuildIds) {
                const hint = trackedCollections.find(tc => tc.guildId === gid)?.name;
                const nm = await this.collectionNames.resolve(contractLcEff, { trackedName: hint });
                whaleNamesByGuild.set(gid, nm.name);
            }
        }

        for (const gid of uniqueGuildIds) {
            const guild = await prisma.guild.findUnique({
                where: { id: gid },
                include: { alertChannels: true },
            });

            if (!guild) continue;

            const defaultWhaleChannelId =
                guild.alertChannels.find(c => c.alertType === 'WHALE_BUY')?.discordChannelId ?? null;

            const relevantWallets = combinedTracked.filter(t => t.guildId === gid);

            for (const wallet of relevantWallets) {
                const channelId = wallet.alertChannelId ?? defaultWhaleChannelId;
                if (!channelId) {
                    console.warn(
                        `[Worker] No whale alert channel for wallet ${wallet.address} (guild ${guild.discordId}); skipping.`,
                    );
                    continue;
                }

                const isSeller =
                    wallet.address.toLowerCase() === from.toLowerCase();
                const behavior: WhaleContextMetrics['behavior'] =
                    eventType === 'MINT' ? 'mint' : isSeller ? 'sell' : 'buy';
                const zKind: 'mint' | 'sell' | 'buy' =
                    behavior === 'mint' ? 'mint' : behavior === 'sell' ? 'sell' : 'buy';
                const zk = this.whaleIntelZKey(zKind, wallet.guildId, contractLcEff);
                const counted = await this.intelWindowDistinct(zk, Date.now());

                let recentTrackedSellsDistinctWallets: number | undefined;
                if (behavior === 'sell') {
                    recentTrackedSellsDistinctWallets = counted.distinct;
                } else {
                    const sells = await this.intelWindowDistinct(
                        this.whaleIntelZKey('sell', wallet.guildId, contractLcEff),
                        Date.now(),
                    );
                    recentTrackedSellsDistinctWallets = sells.distinct;
                }

                const whaleMetrics: WhaleContextMetrics = {
                    behavior,
                    focalWalletTracked: true,
                    priceEth: effectivePriceEth > 0 ? effectivePriceEth : null,
                    currency,
                    marketplace: marketplace || 'Unknown',
                    possibleWashTrading: possibleWashTrading || false,
                    distinctWalletsInWindow: counted.distinct,
                    eventsInWindow: counted.events,
                    windowMinutes: Math.max(1, Math.round(this.INTEL_WINDOW_MS / 60000)),
                    floorEth: floorIntel,
                    floorVsSnapshotPct: floorPctIntel,
                    listingSurgeSuspected: listingSurgeSuspectedFlag,
                    recentTrackedSellsDistinctWallets,
                };

                const cxWhale = explainWhale(whaleMetrics);
                const jobCacheKeyPre = `alert-${wallet.id}-${eventId}-${channelId}`;
                const narrativeWhale = await summarizeFactsWithOptionalAi({
                    explanation: cxWhale,
                    jobCacheKey: jobCacheKeyPre,
                });
                const intelligence: IntelligenceReport = contextualToIntelligenceReport(
                    cxWhale,
                    narrativeWhale,
                );

                const focalForMember = wallet.address.toLowerCase();
                await this.intelWindowRegister(
                    zk,
                    Date.now(),
                    `${focalForMember}:${txHash}:${tokenId}`,
                );

                const focusProfile = isSeller ? sellerProfile : buyerProfile;
                const counterpartyProfile = isSeller ? buyerProfile : sellerProfile;

                await discordDeliveryQueue.add(
                    'discord_alert',
                    {
                        eventId,
                        channelId,
                        alertType:
                            eventType === 'SALE'
                                ? 'WHALE_SALE'
                                : eventType === 'MINT'
                                  ? 'WHALE_MINT'
                                  : 'WHALE_BUY',
                        contract,
                        collectionName:
                            whaleNamesByGuild.get(wallet.guildId) ??
                            formatFallbackCollectionName(contractLcEff),
                        wallet: isSeller ? from : to,
                        label: wallet.label,
                        tokenId,
                        txHash,
                        price,
                        currency,
                        marketplace,
                        intelligence,
                        mentionRoleId: wallet.mentionRoleId,
                        possibleWashTrading: possibleWashTrading || undefined,
                        nftMeta,
                        walletProfile: focusProfile,
                        counterpartyProfile,
                    },
                    {
                        jobId: `alert-${wallet.id}-${eventId}-${channelId}`,
                    },
                );
            }
        }
    }

    /**
     * Wrap NFT enrichment so a hung external call cannot block the worker
     * pipeline. The client already times out at ~4s; this is a belt-and-braces
     * 6s ceiling that converts any unexpected throw into a null result.
     */
    private async safeFetchNFT(
        chain: string,
        contract: string,
        tokenId: string,
    ): Promise<NFTMetadata | null> {
        if (chain !== 'ethereum' || !contract || !tokenId) return null;
        try {
            return await Promise.race<NFTMetadata | null>([
                this.nftMetadata.fetchNFT('ethereum', contract, tokenId),
                new Promise<null>(resolve => setTimeout(() => resolve(null), 6_000)),
            ]);
        } catch (err) {
            console.warn(`[Worker] safeFetchNFT failed for ${contract}:${tokenId}:`, err);
            return null;
        }
    }

    private async safeFetchWallet(address: string): Promise<WalletProfile | null> {
        if (!address) return null;
        try {
            return await Promise.race<WalletProfile | null>([
                this.walletProfiles.fetchProfile(address),
                new Promise<null>(resolve => setTimeout(() => resolve(null), 6_000)),
            ]);
        } catch (err) {
            console.warn(`[Worker] safeFetchWallet failed for ${address}:`, err);
            return null;
        }
    }

    private async dispatchClusterBuy(det: ClusterBuyDetection) {
        const guild = await prisma.guild.findUnique({
            where: { id: det.guildDbId },
            include: {
                alertChannels: true,
                trackedCollections: {
                    where: {
                        chain: 'ethereum',
                        contractAddress: { equals: det.contract, mode: 'insensitive' },
                    },
                },
            },
        });
        if (!guild) return;

        const row = guild.trackedCollections[0];
        const defaultWhaleChannelId =
            guild.alertChannels.find(c => c.alertType === 'WHALE_BUY')?.discordChannelId ?? null;
        const channelId = row?.alertChannelId ?? defaultWhaleChannelId;
        if (!channelId) {
            console.warn(
                `[Worker] CLUSTER_BUY: no channel for guild ${guild.discordId} contract ${det.contract}; skip.`,
            );
            return;
        }

        const windowMin = Math.max(1, Math.round(det.windowMs / 60000));

        // Enrich the trigger buyer + collection only — cluster alerts have no
        // single tokenId, so we deliberately skip per-NFT lookups here.
        const [collectionMeta, triggerProfile] = await Promise.all([
            this.nftMetadata.fetchCollection(det.contract).catch(() => null),
            this.safeFetchWallet(det.triggerBuyer),
        ]);

        const cxCluster = explainClusterBuy({
            walletCount: det.buyers.length,
            windowMinutes: windowMin,
            chain: det.chain,
        });
        const clusterNar = await summarizeFactsWithOptionalAi({
            explanation: cxCluster,
            jobCacheKey: `cluster-${det.guildDbId}-${det.eventId}`,
        });

        const { name: clusterCollectionName } = await this.collectionNames.resolve(
            det.contract.toLowerCase(),
            { trackedName: row?.name },
        );

        await discordDeliveryQueue.add(
            'discord_alert',
            {
                eventId: det.eventId,
                channelId,
                alertType: 'CLUSTER_BUY',
                contract: det.contract,
                chain: det.chain,
                collectionName: clusterCollectionName,
                collectionMeta,
                wallets: det.buyers,
                windowMinutes: windowMin,
                triggerTxHash: det.triggerTxHash,
                triggerBuyer: det.triggerBuyer,
                triggerProfile,
                mentionRoleId: row?.mentionRoleId ?? null,
                contextualExplanation: cxCluster,
                aiNarrative: clusterNar ?? undefined,
            },
            {
                jobId: `cluster-${det.guildDbId}-${det.eventId}`,
                removeOnComplete: { age: 3600 },
                removeOnFail: { age: 86400 },
            },
        );
    }

    private async dispatchSweep(
        sweep: SweepDetection,
        collections: {
            id: string;
            alertChannelId: string | null;
            mentionRoleId: string | null;
            name: string;
            sweepThresholdNative: number | null;
        }[],
    ) {
        const envMinTotal = Number(process.env.SWEEP_MIN_TOTAL_NATIVE) || 0.5;

        // Enrich at most the first three swept tokens (most informative for the
        // embed thumbnail strip without ballooning external request volume) and
        // the buyer profile. Run all lookups in parallel.
        const sampleTokens = sweep.tokenIds.slice(0, 3);
        const [collectionMeta, buyerProfile, ...sampleMetas] = await Promise.all([
            this.nftMetadata.fetchCollection(sweep.contract).catch(() => null),
            this.safeFetchWallet(sweep.buyer),
            ...sampleTokens.map(tid =>
                this.safeFetchNFT(sweep.chain, sweep.contract, tid),
            ),
        ]);

        const chainLcSweep = (sweep.chain || 'ethereum').toLowerCase();
        const contractLcSweep = sweep.contract.toLowerCase();
        const sweepFloor = await this.readFloorNativeCachedOrOpenSea(chainLcSweep, contractLcSweep);
        const sweepFloorPct = await this.floorVsSnapshotPct(chainLcSweep, contractLcSweep, sweepFloor);
        const cxSweep = explainSweep({
            itemCount: sweep.itemCount,
            totalNative: sweep.totalNative,
            currency: sweep.currency,
            floorEth: sweepFloor,
            floorVsSnapshotPct: sweepFloorPct,
        });

        const trackedHintSweep = collections.map(r => r.name).find(n => !isPlaceholderCollectionName(n));
        const { name: sweepCollectionLabel } = await this.collectionNames.resolve(
            sweep.contract.toLowerCase(),
            { trackedName: trackedHintSweep },
        );

        for (const row of collections) {
            const minTotal = row.sweepThresholdNative ?? envMinTotal;
            if (sweep.totalNative < minTotal) continue;
            if (!row.alertChannelId) continue;

            const sweepNar = await summarizeFactsWithOptionalAi({
                explanation: cxSweep,
                jobCacheKey: `sweep-${row.id}-${sweep.eventId}`,
            });

            await discordDeliveryQueue.add(
                'discord_alert',
                {
                    eventId: sweep.eventId,
                    channelId: row.alertChannelId,
                    alertType: 'SWEEP',
                    contract: sweep.contract,
                    chain: sweep.chain,
                    collectionName: sweepCollectionLabel,
                    collectionMeta,
                    buyer: sweep.buyer,
                    buyerProfile,
                    txHash: sweep.txHash,
                    itemCount: sweep.itemCount,
                    totalNative: sweep.totalNative,
                    currency: sweep.currency,
                    tokenIds: sweep.tokenIds,
                    sampleNftMetas: sampleMetas.filter((m): m is NFTMetadata => m !== null),
                    mentionRoleId: row.mentionRoleId,
                    contextualExplanation: cxSweep,
                    aiNarrative: sweepNar ?? undefined,
                },
                {
                    jobId: `sweep-${row.id}-${sweep.eventId}`,
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                },
            );
        }
    }

    private async dispatchHotMint(
        det: HotMintDetection,
        collections: {
            id: string;
            guildId: string;
            alertChannelId: string | null;
            hotMintEnabled: boolean;
            hotMintChannelId: string | null;
            mentionRoleId: string | null;
            name: string;
        }[],
    ) {
        const cdMs = Number(process.env.HOT_MINT_COOLDOWN_MS) || 30 * 60 * 1000;
        try {
            const stamped = await redisConnection.set(
                `hotmint_cool:${det.chain}:${det.contract}`,
                '1',
                'PX',
                cdMs,
                'NX',
            );
            if (stamped !== 'OK') return;
        } catch (err) {
            console.warn('[Worker] Hot mint cooldown redis failed:', err);
            return;
        }

        const guildIds = [...new Set(collections.map(c => c.guildId))];
        const guilds = await prisma.guild.findMany({
            where: { id: { in: guildIds } },
            include: { alertChannels: true },
        });
        const guildById = new Map(guilds.map(g => [g.id, g]));

        const [collectionMeta] = await Promise.all([
            this.nftMetadata.fetchCollection(det.contract).catch(() => null),
        ]);

        const topProfiles = await Promise.all(
            det.topMinters.map(async m => ({
                addr: m.address.toLowerCase(),
                count: m.count,
                profile: await this.safeFetchWallet(m.address),
            })),
        );

        let floorEth: number | null = null;
        try {
            const raw = await redisConnection.get(`floor:ethereum:${det.contract.toLowerCase()}`);
            if (raw) {
                const j = JSON.parse(raw) as { priceNative?: number };
                if (typeof j.priceNative === 'number' && j.priceNative > 0) {
                    floorEth = j.priceNative;
                }
            }
        } catch {
            /* ignore */
        }

        if (floorEth === null) {
            floorEth = await this.readFloorNativeCachedOrOpenSea('ethereum', det.contract);
        }

        const supplyNum = collectionMeta?.totalSupply;
        const pctMinted =
            typeof supplyNum === 'number' &&
            supplyNum > 0 &&
            det.totalMints > 0
                ? Math.min(100, (det.totalMints / supplyNum) * 100)
                : null;

        const windowMin = Math.max(1, Math.round(det.windowMs / 60000));
        const velocityPerMin =
            det.windowMs >= 60_000 ? det.totalMints / (det.windowMs / 60_000) : det.totalMints;

        const blockRange =
            det.blockMin > 0 && det.blockMax > 0 ? `${det.blockMin} → ${det.blockMax}` : '—';

        const topMinerLines = topProfiles.map(tp => {
            const label =
                tp.profile?.ens && tp.profile.ens.trim()
                    ? tp.profile.ens
                    : shortEthAddr(tp.addr);
            return `• ${label} — ${tp.count} mint${tp.count === 1 ? '' : 's'}`;
        });

        const minUniqueCfg =
            Number(process.env.HOT_MINT_MIN_UNIQUE_MINTERS) > 0
                ? Number(process.env.HOT_MINT_MIN_UNIQUE_MINTERS)
                : 15;
        const minTotalCfg =
            Number(process.env.HOT_MINT_MIN_TOTAL_MINTS) > 0
                ? Number(process.env.HOT_MINT_MIN_TOTAL_MINTS)
                : 25;
        const cxHot = explainHotMint({
            uniqueMinters: det.uniqueMinters,
            totalMints: det.totalMints,
            windowMinutes: windowMin,
            velocityPerMin,
            floorEth,
            minUniqueConfigured: minUniqueCfg,
            minTotalConfigured: minTotalCfg,
        });

        const trackedHintHot = collections.map(c => c.name).find(n => !isPlaceholderCollectionName(n));
        const { name: hotMintCollectionLabel } = await this.collectionNames.resolve(
            det.contract.toLowerCase(),
            { trackedName: trackedHintHot },
        );

        for (const row of collections) {
            if (!row.hotMintEnabled) continue;
            const guild = guildById.get(row.guildId);
            const defaultWhaleChannel =
                guild?.alertChannels.find(c => c.alertType === 'WHALE_BUY')?.discordChannelId ?? null;
            const channelId = row.hotMintChannelId ?? row.alertChannelId ?? defaultWhaleChannel;
            if (!channelId) {
                console.warn(`[Worker] HOT_MINT: no channel row=${row.id} contract=${det.contract}`);
                continue;
            }

            const hotNar = await summarizeFactsWithOptionalAi({
                explanation: cxHot,
                jobCacheKey: `hot-mint-${row.id}-${det.eventId}`,
            });

            await discordDeliveryQueue.add(
                'discord_alert',
                {
                    eventId: det.eventId,
                    channelId,
                    alertType: 'HOT_MINT',
                    contract: det.contract,
                    chain: det.chain,
                    collectionName: hotMintCollectionLabel,
                    collectionMeta,
                    uniqueMinters: det.uniqueMinters,
                    totalMints: det.totalMints,
                    windowMinutes: windowMin,
                    velocityPerMin,
                    pctSupplyMinted: pctMinted,
                    floorEth,
                    blockRange,
                    topMinerLines,
                    mentionRoleId: row.mentionRoleId,
                    contextualExplanation: cxHot,
                    aiNarrative: hotNar ?? undefined,
                },
                {
                    jobId: `hot-mint-${row.id}-${det.eventId}`,
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                },
            );
        }
    }

    private async handleMintRadar(chain: string, contract: string) {
        const velocityThreshold = 50; 
        const redisKey = `mint_velocity:${chain}:${contract}`;
        const currentMints = await redisConnection.incr(redisKey);
        
        if (currentMints === 1) {
            await redisConnection.expire(redisKey, 300); // 5 mins
        }

        if (currentMints === velocityThreshold) {
            const mintChannels = await prisma.alertChannel.findMany({
                where: { alertType: 'MINT_RADAR' },
                include: { guild: true }
            });

            // Use a deterministic time-bucketed eventId so dedupe works across worker replicas
            const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
            const eventId = `mint-radar-${chain}-${contract}-${bucket}`;
            // Mint radar carries no tokenId; collection metadata is the most we
            // can enrich. One fetch shared across every guild's alert.
            const collectionMeta = await this.nftMetadata.fetchCollection(contract).catch(() => null);
            const { name: mintRadarCollectionName } = await this.collectionNames.resolve(
                contract.toLowerCase(),
            );
            for (const ch of mintChannels) {
                await discordDeliveryQueue.add('discord_alert', {
                    eventId,
                    guildId: ch.guild.discordId,
                    channelId: ch.discordChannelId,
                    alertType: 'MINT_RADAR',
                    chain, contract,
                    velocity: currentMints,
                    timeWindowMin: 5,
                    collectionName: mintRadarCollectionName,
                    collectionMeta,
                }, {
                    jobId: `mint-alert-${chain}-${contract}-${bucket}`
                });
            }
        }
    }
}

if (require.main === module) {
    const worker = new EventWorker();
    worker.start().catch(err => {
        console.error('❌ Failed to start Event Worker:', err);
        process.exit(1);
    });
}
