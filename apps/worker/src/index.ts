import { Worker, Job } from 'bullmq';
import {
    redisConnection,
    discordQueue as discordDeliveryQueue,
    walletActionBatchQueue,
    mintTriggersQueue,
} from '@superbot/queue';
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
    NftNameResolver,
    isPlaceholderCollectionName,
    formatFallbackCollectionName,
    type NormalizedSale,
    type SweepDetection,
    type ClusterBuyDetection,
    type NFTMetadata,
    type WalletProfile,
    type HotMintDetection,
    WalletActionBatcher,
    buildWalletActionBatchBase,
    deterministicWalletBatchEventId,
    mapEngineBehaviorToBatchKey,
    parseStoredWhaleBatchEvents,
    type WhaleActionBatchStoredEvent,
    markOpportunityHotContract,
    recordOpportunityTrade,
    recordOpportunitySweep,
    recordOpportunityTrackedBuy,
    isOpportunityHotContract,
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

function readWalletBatchEnabled(): boolean {
    return process.env.WALLET_BATCH_ENABLED !== 'false';
}

function readWalletBatchFlushMs(): number {
    const n = Number(process.env.WALLET_BATCH_FLUSH_MS);
    if (!(n >= 0) || Number.isNaN(n)) return 90_000;
    return Math.floor(n);
}

function readWalletBatchMaxItems(): number {
    const n = Number(process.env.WALLET_BATCH_MAX_ITEMS);
    if (!(n >= 2) || Number.isNaN(n)) return 100;
    return Math.floor(n);
}

function batchEmbedBehaviorFromAlertType(t: string | undefined): 'buy' | 'sale' | 'mint' {
    if (t === 'WHALE_SALE') return 'sale';
    if (t === 'WHALE_MINT') return 'mint';
    return 'buy';
}

function walletBatchRoutingActive(): boolean {
    return readWalletBatchEnabled() && readWalletBatchFlushMs() > 0;
}

function shortEthAddr(addr: string): string {
    if (!addr) return '—';
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

type AlertChannelRouting = {
    alertType: string;
    discordChannelId: string;
    mentionRoleId: string | null;
};

/** First matching alert-type row wins; used so dashboard can add dedicated routes per type. */
function discordChannelForTypes(
    channels: AlertChannelRouting[],
    preferenceOrder: string[],
): string | null {
    for (const t of preferenceOrder) {
        const row = channels.find(c => c.alertType === t);
        if (row?.discordChannelId) return row.discordChannelId;
    }
    return null;
}

/** Guild route ping role: first preference order hit with a non-empty mentionRoleId wins. */
function mentionRoleForTypes(
    channels: { alertType: string; mentionRoleId: string | null }[],
    preferenceOrder: string[],
): string | null {
    for (const t of preferenceOrder) {
        const row = channels.find(c => c.alertType === t);
        const id = row?.mentionRoleId;
        if (typeof id === 'string' && id.trim()) return id.trim();
    }
    return null;
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
    private hotMintDetector = new HotMintDetector(redisConnection);
    private openSeaFloor = new OpenSeaSalesClient();
    private rpcPool: RpcPool | null = null;
    private collectionNames!: CollectionNameResolver;
    private nftNames!: NftNameResolver;
    private whaleActionBatcher!: WalletActionBatcher;

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
        this.nftNames = new NftNameResolver({
            redis: redisConnection,
            nftMetadata: this.nftMetadata,
            rpcPool:
                this.rpcPool && this.rpcPool.httpsUrls.length > 0 ? this.rpcPool : null,
        });

        this.whaleActionBatcher = new WalletActionBatcher(
            redisConnection,
            walletActionBatchQueue,
            {
                enabled: readWalletBatchEnabled(),
                flushMs: readWalletBatchFlushMs(),
                maxItems: readWalletBatchMaxItems(),
                onFlushBatch: batchBase => this.flushWalletActionBatch(batchBase),
            },
        );

        console.log('[Worker] HotMintDetector initialized (Ethereum, Redis-backed window for multi-replica).');
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

        const walletBatchFlushWorker = new Worker(
            'wallet_action_batch',
            async (job: Job) => {
                if (job.name === 'wallet_action_batch_flush') {
                    await this.flushWalletActionBatch(String(job.data?.batchBase ?? ''));
                }
            },
            { connection: redisConnection, concurrency: 4 },
        );
        walletBatchFlushWorker.on('failed', (job, err) => {
            console.error(`❌ wallet_action_batch job ${job?.id} failed:`, err);
        });
    }

    private mergeWhaleBatchMetrics(items: WhaleActionBatchStoredEvent[]): WhaleContextMetrics {
        const first = items[0];
        const base = JSON.parse(JSON.stringify(first.whaleMetricsJson)) as WhaleContextMetrics;
        const txs = new Set(items.map(i => String(i.txHash || '')));
        txs.delete('');
        const total = items.reduce((s, i) => s + (Number.isFinite(i.priceNative) && i.priceNative > 0 ? i.priceNative : 0), 0);
        const pricedN = items.filter(i => i.priceNative > 0).length;
        base.batchItemCount = items.length;
        base.batchTxCount = txs.size;
        base.batchTotalEth = total > 0 ? total : null;
        base.priceEth = pricedN > 0 ? total / pricedN : null;
        if (items.some(i => Boolean(i.discordPayload.possibleWashTrading))) {
            base.possibleWashTrading = true;
        }
        const mkts = items
            .map(i => String(i.discordPayload.marketplace ?? i.marketplace ?? '').trim())
            .filter(Boolean);
        if (mkts.length > 0 && mkts.every(m => m === mkts[0])) {
            base.marketplace = mkts[0];
        }
        return base;
    }

    private async flushWalletActionBatch(batchBase: string): Promise<void> {
        if (!batchBase) return;
        const rawRows = await this.whaleActionBatcher.drain(batchBase);
        const items = parseStoredWhaleBatchEvents(rawRows as unknown);

        console.log(`[Batcher] flushed ${batchBase} with ${items.length} events`);

        if (items.length === 0) return;

        if (items.length === 1) {
            const solo = items[0].discordPayload;
            const trackedId = typeof solo.trackedWalletDbId === 'string' ? solo.trackedWalletDbId : '';
            const evid = solo.eventId ?? solo.txHash;
            const cid = solo.channelId;
            if (!evid || typeof cid !== 'string') return;
            const jobSuffix = trackedId ? trackedId : 'nowallet';
            await discordDeliveryQueue.add(
                'discord_alert',
                solo as Record<string, unknown>,
                { jobId: `alert-${jobSuffix}-${evid}-${cid}` },
            );
            return;
        }

        const first = items[0].discordPayload;
        const merged = this.mergeWhaleBatchMetrics(items);
        const cxWhale = explainWhale(merged);
        const channelId = typeof first.channelId === 'string' ? first.channelId : '';
        if (!channelId) return;

        const focalWalletLc = items[0].focalWalletLc;
        const chainLcPayload = String(first.chain || 'ethereum').toLowerCase();
        const contractStr = typeof first.contract === 'string' ? first.contract : '';
        const contractLcPayload = contractStr.toLowerCase();

        const firstSeenAt = Math.min(...items.map(i => i.firstSeenAtCandidate));
        const lastSeenAt = Math.max(...items.map(i => i.enqueuedAtMs));

        const behaviorEmbed = batchEmbedBehaviorFromAlertType(
            typeof first.alertType === 'string' ? first.alertType : undefined,
        );
        const behaviorForId =
            behaviorEmbed === 'sale' ? 'sale' : behaviorEmbed === 'mint' ? 'mint' : ('buy' as const);

        const batchEventId = deterministicWalletBatchEventId({
            chainLc: chainLcPayload,
            contractLc: contractLcPayload || contractStr,
            walletLc: focalWalletLc,
            behavior: behaviorForId,
            firstSeenAtMs: firstSeenAt,
        });

        const jobCacheKeyBatch = `${batchEventId}:${channelId}`;
        const nar = await summarizeFactsWithOptionalAi({
            explanation: cxWhale,
            jobCacheKey: jobCacheKeyBatch,
        });
        const intelligence: IntelligenceReport = contextualToIntelligenceReport(cxWhale, nar);

        const txHashesOrdered: string[] = [];
        const seenTx = new Set<string>();
        for (const row of items) {
            const h = String(row.txHash || '');
            if (!/^0x[a-fA-F0-9]{64}$/.test(h) || seenTx.has(h)) continue;
            seenTx.add(h);
            txHashesOrdered.push(h);
        }

        const blocks = items
            .map(i => i.blockNumber)
            .filter((b): b is number => typeof b === 'number' && b > 0);
        const blockRange =
            blocks.length > 0
                ? { first: Math.min(...blocks), last: Math.max(...blocks) }
                : { first: 0, last: 0 };

        const sampleTokenIds: string[] = [];
        const sampleNftNames: string[] = [];
        const tokSeen = new Set<string>();
        for (const row of items) {
            const tid = String(row.tokenId);
            if (!tid || tokSeen.has(tid)) continue;
            tokSeen.add(tid);
            sampleTokenIds.push(tid);
            const nmRaw = row.discordPayload.nftName;
            const nm = typeof nmRaw === 'string' && nmRaw.trim() ? nmRaw.trim() : '';
            sampleNftNames.push(nm || `#${tid}`);
            if (sampleTokenIds.length >= 5) break;
        }

        const mktsFlush = items
            .map(i => String(i.discordPayload.marketplace ?? i.marketplace ?? '').trim())
            .filter(Boolean);
        const uniformMarket =
            mktsFlush.length > 0 && mktsFlush.every(m => m === mktsFlush[0]) ? mktsFlush[0] : undefined;

        const totalNative = items.reduce(
            (s, i) => s + (Number.isFinite(i.priceNative) ? i.priceNative : 0),
            0,
        );
        const currency =
            typeof first.currency === 'string' && first.currency.trim()
                ? first.currency.trim()
                : 'ETH';

        const batchPayload = {
            eventId: batchEventId,
            channelId,
            alertType: 'WALLET_ACTION_BATCH',
            chain: chainLcPayload,
            contract: contractStr,
            collectionName: typeof first.collectionName === 'string' ? first.collectionName : '',
            wallet: typeof first.wallet === 'string' ? first.wallet : focalWalletLc,
            label: first.label ?? null,
            walletProfile: first.walletProfile ?? null,
            nftMeta: first.nftMeta ?? null,
            intelligence,
            mentionRoleId: typeof first.mentionRoleId === 'string' ? first.mentionRoleId : null,
            batchBehavior: behaviorEmbed,
            batch: {
                itemCount: items.length,
                totalNative,
                txHashes: txHashesOrdered,
                blockRange,
                firstSeenAt,
                lastSeenAt,
                sampleTokenIds,
                sampleNftNames,
                marketplace: uniformMarket,
                currency,
                possibleWashTrading: items.some(i => Boolean(i.discordPayload.possibleWashTrading)),
            },
        };

        await discordDeliveryQueue.add('discord_alert', batchPayload, {
            jobId: `wallet-action-batch:${batchEventId}:${channelId}`,
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
        mentionRoleId?: string | null;
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
                mentionRoleId:
                    typeof data.mentionRoleId === 'string' && data.mentionRoleId.trim()
                        ? data.mentionRoleId.trim()
                        : null,
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
            const hotDet = await this.hotMintDetector.ingestAsync({
                chain: chainLc,
                contract: contract.toLowerCase(),
                minter: to.toLowerCase(),
                blockNumber: jobBlock !== undefined && jobBlock > 0 ? jobBlock : undefined,
                tsMs,
                eventId: typeof eventId === 'string' && eventId ? eventId : `${txHash}:${tokenId}`,
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

        const tsMillis =
            jobTs !== undefined && jobTs > 0
                ? jobTs > 1e12
                  ? jobTs
                  : jobTs * 1000
                : Date.now();

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
                await markOpportunityHotContract(redisConnection, sweep.chain, sweep.contract).catch(() => {});
                await recordOpportunitySweep(redisConnection, {
                    chain: sweep.chain,
                    contract: sweep.contract,
                    tsMs: tsMillis,
                    eventId: sweep.eventId,
                    itemCount: sweep.itemCount,
                    totalNative: sweep.totalNative,
                    uniqueBuyers: 1,
                }).catch(() => {});
                await this.dispatchSweep(sweep, trackedCollections);
            }

            const seenClusterGuilds = new Set<string>();
            for (const w of trackedBuyers) {
                if (seenClusterGuilds.has(w.guildId)) continue;
                seenClusterGuilds.add(w.guildId);
                const cluster = this.clusterDetector.ingest(normalized, w.guildId);
                if (cluster) {
                    await markOpportunityHotContract(redisConnection, cluster.chain, cluster.contract).catch(() => {});
                    await this.dispatchClusterBuy(cluster);
                }
            }

            const chainLcOp = (chain || 'ethereum').toLowerCase();
            const contractLcOp = contract.toLowerCase();
            const shouldIngestTrade =
                trackedCollections.length > 0 ||
                (await isOpportunityHotContract(redisConnection, chainLcOp, contractLcOp));
            if (shouldIngestTrade) {
                await recordOpportunityTrade(redisConnection, {
                    chain: chainLcOp,
                    contract: contractLcOp,
                    tsMs: tsMillis,
                    buyer: normalized.buyer,
                    seller: normalized.seller,
                    priceNative: effectivePriceEth,
                    txHash,
                    eventId: normalized.eventId,
                }).catch(() => {});
            }
        }

        if (trackedBuyers.length === 0 && trackedSellers.length === 0) return;

        if (from !== '0x0000000000000000000000000000000000000000' && eventType !== 'SALE' && effectivePriceEth > 0) {
            eventType = 'SALE';
            price = String(effectivePriceEth);
        }

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

            const relevantWallets = combinedTracked.filter(t => t.guildId === gid);

            for (const wallet of relevantWallets) {
                const whaleAlertType =
                    eventType === 'SALE'
                        ? 'WHALE_SALE'
                        : eventType === 'MINT'
                          ? 'WHALE_MINT'
                          : 'WHALE_BUY';

                if (
                    whaleAlertType === 'WHALE_MINT' &&
                    process.env.MINT_COPY_CONFIRMED_ENABLED === 'true' &&
                    chainLc === 'ethereum'
                ) {
                    const jid = `minttrig_${txHash}_${wallet.id}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
                    void mintTriggersQueue
                        .add(
                            'COPY_CONFIRMED_MINT',
                            {
                                guildDiscordId: guild.discordId,
                                trackedWallet: wallet.address.toLowerCase(),
                                collectionAddress: contract.toLowerCase(),
                                chainId: 1,
                                txHash,
                            },
                            { jobId: jid, removeOnComplete: { count: 500 } },
                        )
                        .catch((err: unknown) =>
                            console.warn('[Worker] mintTriggersQueue enqueue failed:', err),
                        );
                }

                const defaultWhaleChannelId = discordChannelForTypes(guild.alertChannels, [
                    whaleAlertType,
                    ...(whaleAlertType === 'WHALE_SALE'
                        ? (['WHALE_BUY'] as const)
                        : whaleAlertType === 'WHALE_MINT'
                          ? (['WHALE_BUY'] as const)
                          : (['WHALE_SALE'] as const)),
                ]);
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

                const whaleCollectionLabel =
                    whaleNamesByGuild.get(wallet.guildId) ??
                    formatFallbackCollectionName(contractLcEff);
                const { name: whaleNftLabel } = await this.nftNames.resolveNftName(
                    contractLcEff,
                    String(tokenId),
                    { collectionName: whaleCollectionLabel },
                );

                const whaleRouteMention = mentionRoleForTypes(guild.alertChannels, [
                    whaleAlertType,
                    'WHALE_BUY',
                    'WHALE_SALE',
                ]);
                if (whaleAlertType === 'WHALE_BUY' && !isSeller) {
                    await markOpportunityHotContract(redisConnection, chainLc, contractLcEff).catch(() => {});
                    await recordOpportunityTrackedBuy(
                        redisConnection,
                        chainLc,
                        contractLcEff,
                        tsMillis,
                        `${wallet.id}:${eventId}:${txHash}`,
                    ).catch(() => {});
                }

                const whaleDiscordPayload: Record<string, unknown> = {
                    eventId,
                    channelId,
                    alertType: whaleAlertType,
                    contract,
                    collectionName: whaleCollectionLabel,
                    nftName: whaleNftLabel,
                    wallet: isSeller ? from : to,
                    label: wallet.label,
                    trackedWalletDbId: wallet.id,
                    chain: chainLc,
                    tokenId,
                    txHash,
                    price,
                    currency,
                    marketplace,
                    intelligence,
                    mentionRoleId: wallet.mentionRoleId ?? whaleRouteMention,
                    possibleWashTrading: possibleWashTrading || undefined,
                    nftMeta,
                    walletProfile: focusProfile,
                    counterpartyProfile,
                };

                const soloJobOpts = {
                    jobId: `alert-${wallet.id}-${eventId}-${channelId}`,
                };

                if (walletBatchRoutingActive()) {
                    const stored: WhaleActionBatchStoredEvent = {
                        version: 1,
                        discordPayload:
                            whaleDiscordPayload as WhaleActionBatchStoredEvent['discordPayload'],
                        whaleMetricsJson: JSON.parse(JSON.stringify(whaleMetrics)) as Record<
                            string,
                            unknown
                        >,
                        focalWalletLc: focalForMember,
                        firstSeenAtCandidate: tsMillis,
                        enqueuedAtMs: Date.now(),
                        priceNative: effectivePriceEth,
                        blockNumber: jobBlock ?? undefined,
                        txHash,
                        tokenId,
                        marketplace,
                    };
                    const batchBase = buildWalletActionBatchBase({
                        chainLc,
                        contractLc: contractLcEff,
                        guildDbId: wallet.guildId,
                        walletLc: focalForMember,
                        behavior: mapEngineBehaviorToBatchKey(behavior),
                    });
                    const enqueueResult = await this.whaleActionBatcher.enqueue(stored, batchBase);
                    if (enqueueResult === 'immediate_fallback') {
                        await discordDeliveryQueue.add(
                            'discord_alert',
                            whaleDiscordPayload,
                            soloJobOpts,
                        );
                    }
                } else {
                    await discordDeliveryQueue.add(
                        'discord_alert',
                        whaleDiscordPayload,
                        soloJobOpts,
                    );
                }
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
        const defaultWhaleChannelId = discordChannelForTypes(guild.alertChannels, ['CLUSTER_BUY', 'WHALE_BUY']);
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

        let clusterTriggerNftName: string | undefined;
        if (det.triggerTokenId) {
            clusterTriggerNftName = (
                await this.nftNames.resolveNftName(det.contract.toLowerCase(), det.triggerTokenId, {
                    collectionName: clusterCollectionName,
                })
            ).name;
        }

        await discordDeliveryQueue.add(
            'discord_alert',
            {
                eventId: det.eventId,
                channelId,
                alertType: 'CLUSTER_BUY',
                contract: det.contract,
                chain: det.chain,
                collectionName: clusterCollectionName,
                nftName: clusterTriggerNftName,
                triggerTokenId: det.triggerTokenId,
                collectionMeta,
                wallets: det.buyers,
                windowMinutes: windowMin,
                triggerTxHash: det.triggerTxHash,
                triggerBuyer: det.triggerBuyer,
                triggerProfile,
                mentionRoleId:
                    row?.mentionRoleId ??
                    mentionRoleForTypes(guild.alertChannels, ['CLUSTER_BUY', 'WHALE_BUY']),
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
            guildId: string;
            alertChannelId: string | null;
            mentionRoleId: string | null;
            name: string;
            sweepThresholdNative: number | null;
        }[],
    ) {
        const envMinTotal = Number(process.env.SWEEP_MIN_TOTAL_NATIVE) || 0.5;
        const guildIds = [...new Set(collections.map(c => c.guildId))];
        const guildsSweep = await prisma.guild.findMany({
            where: { id: { in: guildIds } },
            include: { alertChannels: true },
        });
        const guildByIdSweep = new Map(guildsSweep.map(g => [g.id, g]));

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

        const sampleNftNames = await Promise.all(
            sampleTokens.map(tid =>
                this.nftNames
                    .resolveNftName(contractLcSweep, String(tid), { collectionName: sweepCollectionLabel })
                    .then(r => r.name),
            ),
        );

        for (const row of collections) {
            const minTotal = row.sweepThresholdNative ?? envMinTotal;
            if (sweep.totalNative < minTotal) continue;
            if (!row.alertChannelId) continue;

            const sweepNar = await summarizeFactsWithOptionalAi({
                explanation: cxSweep,
                jobCacheKey: `sweep-${row.id}-${sweep.eventId}`,
            });

            const gSweep = guildByIdSweep.get(row.guildId);
            const sweepRouteMention = mentionRoleForTypes(gSweep?.alertChannels ?? [], [
                'SWEEP',
                'WHALE_BUY',
            ]);
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
                    sampleNftNames,
                    mentionRoleId: row.mentionRoleId ?? sweepRouteMention,
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

        await markOpportunityHotContract(redisConnection, det.chain, det.contract).catch(() => {});

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
                : 5;
        const minTotalCfg =
            Number(process.env.HOT_MINT_MIN_TOTAL_MINTS) > 0
                ? Number(process.env.HOT_MINT_MIN_TOTAL_MINTS)
                : 10;
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
            const defaultWhaleChannel = discordChannelForTypes(guild?.alertChannels ?? [], [
                'HOT_MINT',
                'WHALE_BUY',
                'MINT_RADAR',
            ]);
            const channelId = row.hotMintChannelId ?? row.alertChannelId ?? defaultWhaleChannel;
            if (!channelId) {
                console.warn(`[Worker] HOT_MINT: no channel row=${row.id} contract=${det.contract}`);
                continue;
            }

            const hotNar = await summarizeFactsWithOptionalAi({
                explanation: cxHot,
                jobCacheKey: `hot-mint-${row.id}-${det.eventId}`,
            });

            console.log(
                `[HotMint] enqueue discord_alert type=HOT_MINT eventId=${det.eventId} minters=${det.uniqueMinters} totalMints=${det.totalMints} windowMin=${windowMin}`,
            );

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
                    mentionRoleId:
                        row.mentionRoleId ??
                        mentionRoleForTypes(guild?.alertChannels ?? [], [
                            'HOT_MINT',
                            'MINT_RADAR',
                            'WHALE_BUY',
                        ]),
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
                    mentionRoleId: ch.mentionRoleId,
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
