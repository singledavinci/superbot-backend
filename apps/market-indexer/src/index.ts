import * as dotenv from 'dotenv';
import { discordQueue, floorImpactQueue, redisConnection } from '@superbot/queue';
import { prisma } from '@superbot/database';
import {
    MassListingDetector,
    MassDelistDetector,
    NFTMetadataClient,
    OpenSeaSalesClient,
    SalesProvider,
    createRpcPoolFromEnv,
    CollectionNameResolver,
    type RpcPool,
} from '@superbot/analytics';
import {
    explainMassListing,
    explainMassDelist,
    summarizeFactsWithOptionalAi,
} from '@superbot/intelligence';

dotenv.config();

const FLOOR_IMPACT_DELAY_MS = Number(process.env.FLOOR_IMPACT_DELAY_MS) || 10 * 60 * 1000;

/**
 * Polls OpenSea for floor snapshots + listing / cancel events per tracked contract (deduped),
 * writes floor readings to Redis for the floor-checker worker, and emits mass-listing / mass-delist alerts.
 *
 * Requires OPENSEA_API_KEY; without it the service stays idle (no mock data).
 */
export class MarketIndexer {
    private provider: SalesProvider | null = null;
    private listingDetector = new MassListingDetector();
    private delistDetector = new MassDelistDetector();
    /** Same collection enrichment pattern as EventWorker sweep/cluster alerts */
    private nftMetadata = new NFTMetadataClient({ redis: redisConnection });
    private rpcPool: RpcPool | null = null;
    private collectionNames!: CollectionNameResolver;
    private pollIntervalMs = Number(process.env.MARKET_POLL_INTERVAL_MS) || 60_000;
    private timer: NodeJS.Timeout | null = null;
    private listingCursorByContract = new Map<string, string>();
    private cancelCursorByContract = new Map<string, string>();
    /** Per-contract minimum listing surge required (max of guild prefs). */
    private massListingMinByContract = new Map<string, number>();
    private massDelistMinDefault = Number(process.env.MASS_DELIST_MIN_COUNT) || 8;

    constructor() {
        const opensea = new OpenSeaSalesClient();
        this.provider = opensea.isConfigured() ? opensea : null;
        this.rpcPool = createRpcPoolFromEnv();
        this.collectionNames = new CollectionNameResolver({
            redis: redisConnection,
            nftMetadata: this.nftMetadata,
            rpcPool:
                this.rpcPool && this.rpcPool.httpsUrls.length > 0 ? this.rpcPool : null,
        });
    }

    public async start() {
        if (!this.provider) {
            console.warn(
                '[MarketIndexer] OPENSEA_API_KEY not set — market indexer idle (no synthetic data). OpenSea is required for listings/floor polling.',
            );
            await new Promise(() => {});
            return;
        }

        console.log(
            `[MarketIndexer] Started with provider="${this.provider.name}". Polling every ${this.pollIntervalMs}ms.`,
        );
        await this.tick();
        this.timer = setInterval(() => {
            this.tick().catch(err => console.error('[MarketIndexer] tick error:', err));
        }, this.pollIntervalMs);
    }

    public async stop() {
        if (this.timer) clearInterval(this.timer);
    }

    private async readFloorNative(chain: string, contract: string): Promise<number | null> {
        const ch = (chain || 'ethereum').toLowerCase();
        try {
            const raw = await redisConnection.get(`floor:${ch}:${contract.toLowerCase()}`);
            if (raw) {
                const j = JSON.parse(raw) as { priceNative?: number };
                if (typeof j.priceNative === 'number' && j.priceNative > 0) return j.priceNative;
            }
        } catch {
            /* ignore malformed cache */
        }

        if (!this.provider) return null;
        try {
            const f = await Promise.race([
                this.provider.fetchFloor({ contract, chain: ch }),
                new Promise<null>(r => setTimeout(() => r(null), 16_000)),
            ]);
            return f && typeof f.priceNative === 'number' && f.priceNative > 0 ? f.priceNative : null;
        } catch {
            return null;
        }
    }

    private async scheduleFloorImpact(args: {
        eventId: string;
        channelId: string;
        alertType: 'MASS_LISTING' | 'MASS_DELIST';
        contract: string;
        chain: string;
        floorBefore: number | null;
        mentionRoleId: string | null;
    }) {
        try {
            await floorImpactQueue.add(
                'floor_impact_check',
                {
                    originalEventId: args.eventId,
                    channelId: args.channelId,
                    alertType: args.alertType,
                    contract: args.contract,
                    chain: args.chain,
                    floorBefore: args.floorBefore,
                    mentionRoleId: args.mentionRoleId,
                    scheduledAt: Date.now(),
                    dueAt: Date.now() + FLOOR_IMPACT_DELAY_MS,
                },
                {
                    delay: FLOOR_IMPACT_DELAY_MS,
                    jobId: `floor_impact:${args.eventId}`,
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                },
            );
        } catch (err) {
            console.warn('[MarketIndexer] floor_impact enqueue failed:', err);
        }
    }

    private async tick() {
        if (!this.provider) return;

        const collections = await prisma.trackedCollection.findMany({
            select: { contractAddress: true, chain: true },
        });
        if (collections.length === 0) return;

        const unique = new Map<string, { contract: string; chain: 'ethereum' }>();
        for (const c of collections) {
            const chain = (c.chain || 'ethereum').toLowerCase();
            if (chain !== 'ethereum') continue;
            const contract = c.contractAddress.toLowerCase();
            unique.set(`${chain}:${contract}`, { contract, chain: 'ethereum' });
        }

        const defaultMassMin = Number(process.env.MASS_LISTING_MIN_COUNT) || 8;
        this.massListingMinByContract.clear();
        for (const { contract } of unique.values()) {
            const rows = await prisma.trackedCollection.findMany({
                where: {
                    chain: 'ethereum',
                    contractAddress: { equals: contract, mode: 'insensitive' },
                },
                select: { massListingThreshold: true },
            });
            const customs = rows
                .map(r => r.massListingThreshold)
                .filter((x): x is number => x != null && x > 0);
            /** Fire the detector as soon as the most sensitive tracked guild would care. */
            const minL = customs.length > 0 ? Math.min(...customs) : defaultMassMin;
            this.massListingMinByContract.set(contract.toLowerCase(), Math.max(1, minL));
        }

        for (const { contract, chain } of unique.values()) {
            const key = `${chain}:${contract}`;
            const minForContract =
                this.massListingMinByContract.get(contract.toLowerCase()) ?? defaultMassMin;

            try {
                const floor = await this.provider.fetchFloor({ contract, chain });
                if (floor) {
                    const payload = JSON.stringify({
                        priceNative: floor.priceNative,
                        currency: floor.currency,
                        source: floor.source,
                        ts: Date.now(),
                    });
                    await redisConnection.set(`floor:${chain}:${contract}`, payload);
                }

                const floorBefore = await this.readFloorNative(chain, contract);

                const listingCursor = this.listingCursorByContract.get(key);
                const listingResult = await this.provider.fetchListings({
                    contract,
                    chain,
                    cursor: listingCursor,
                    limit: 50,
                });

                for (const listing of listingResult.listings) {
                    const det = this.listingDetector.ingest(listing, {
                        minListings: minForContract,
                    });
                    if (det) {
                        try {
                            await redisConnection.set(`intel:listing_surge:${det.contract.toLowerCase()}`, '1', 'EX', 900);
                        } catch {
                            /* best-effort */
                        }
                        await this.dispatchMassListing(det, floorBefore);
                    }
                }

                if (listingResult.nextCursor) {
                    this.listingCursorByContract.set(key, listingResult.nextCursor);
                }

                if (listingResult.listings.length > 0) {
                    console.log(
                        `[MarketIndexer] ${listingResult.listings.length} listing events for ${contract} (cursor=${listingResult.nextCursor ?? 'unchanged'})`,
                    );
                }

                const cancelCursor = this.cancelCursorByContract.get(key);
                const cancelResult = await this.provider.fetchCancellations({
                    contract,
                    chain,
                    cursor: cancelCursor,
                    limit: 50,
                });

                for (const c of cancelResult.listings) {
                    const del = this.delistDetector.ingest(c, {
                        minCancels: this.massDelistMinDefault,
                    });
                    if (del) {
                        await this.dispatchMassDelist(del, floorBefore);
                    }
                }

                if (cancelResult.nextCursor) {
                    this.cancelCursorByContract.set(key, cancelResult.nextCursor);
                }

                if (cancelResult.listings.length > 0) {
                    console.log(
                        `[MarketIndexer] ${cancelResult.listings.length} cancel/delist events for ${contract} (cursor=${cancelResult.nextCursor ?? 'unchanged'})`,
                    );
                }
            } catch (err) {
                console.error(`[MarketIndexer] Failed ${contract}:`, err);
            }
        }
    }

    private async dispatchMassListing(
        det: {
            bucketStart: number;
            chain: string;
            contract: string;
            count: number;
            windowMs: number;
        },
        floorBefore: number | null,
    ) {
        const defaultMin = Number(process.env.MASS_LISTING_MIN_COUNT) || 8;

        const rows = await prisma.trackedCollection.findMany({
            where: {
                chain: 'ethereum',
                contractAddress: { equals: det.contract, mode: 'insensitive' },
            },
        });

        const collectionMeta =
            rows.length === 0
                ? null
                : await this.nftMetadata.fetchCollection(det.contract).catch(() => null);

        for (const row of rows) {
            const minListings = row.massListingThreshold ?? defaultMin;
            if (det.count < minListings) continue;
            if (!row.alertChannelId) continue;

            const eventId = `${det.contract}:${det.bucketStart}:${row.id}`;

            const cxMass = explainMassListing({
                listingCount: det.count,
                windowMs: det.windowMs,
                floorBeforeEth:
                    typeof floorBefore === 'number' && floorBefore > 0 ? floorBefore : null,
            });
            const massNar = await summarizeFactsWithOptionalAi({
                explanation: cxMass,
                jobCacheKey: eventId,
            });

            const { name: massListingCollectionName } = await this.collectionNames.resolve(
                det.contract.toLowerCase(),
                { trackedName: row.name },
            );

            const impactRoute = await prisma.alertChannel.findUnique({
                where: {
                    guildId_alertType: { guildId: row.guildId, alertType: 'FLOOR_IMPACT_FOLLOWUP' },
                },
                select: { mentionRoleId: true },
            });
            const listingRoute = await prisma.alertChannel.findUnique({
                where: {
                    guildId_alertType: { guildId: row.guildId, alertType: 'MASS_LISTING' },
                },
                select: { mentionRoleId: true },
            });
            const listingPing =
                row.mentionRoleId ?? listingRoute?.mentionRoleId ?? null;

            await discordQueue.add(
                'discord_alert',
                {
                    eventId,
                    channelId: row.alertChannelId,
                    alertType: 'MASS_LISTING',
                    contract: det.contract,
                    chain: det.chain,
                    collectionName: massListingCollectionName,
                    collectionMeta,
                    listingCount: det.count,
                    windowMs: det.windowMs,
                    mentionRoleId: listingPing,
                    floorBeforeEth: floorBefore,
                    floorImpactPending: true,
                    contextualExplanation: cxMass,
                    aiNarrative: massNar ?? undefined,
                },
                {
                    jobId: `mass-listing-${row.id}-${det.bucketStart}-${minListings}`,
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                },
            );

            await this.scheduleFloorImpact({
                eventId,
                channelId: row.alertChannelId,
                alertType: 'MASS_LISTING',
                contract: det.contract,
                chain: det.chain,
                floorBefore,
                mentionRoleId: impactRoute?.mentionRoleId ?? null,
            });
        }
    }

    private async dispatchMassDelist(
        det: {
            bucketStart: number;
            chain: string;
            contract: string;
            count: number;
            windowMs: number;
            sampleOrderIds: string[];
        },
        floorBefore: number | null,
    ) {
        const rows = await prisma.trackedCollection.findMany({
            where: {
                chain: 'ethereum',
                contractAddress: { equals: det.contract, mode: 'insensitive' },
            },
        });

        const collectionMeta =
            rows.length === 0
                ? null
                : await this.nftMetadata.fetchCollection(det.contract).catch(() => null);

        for (const row of rows) {
            if (row.delistAlertEnabled === false) continue;
            if (det.count < this.massDelistMinDefault) continue;

            const channelId = row.delistChannelId ?? row.alertChannelId;
            if (!channelId) continue;

            const eventId = `delist:${det.contract}:${det.bucketStart}:${row.id}`;

            const cxDel = explainMassDelist({
                delistCount: det.count,
                windowMs: det.windowMs,
                floorBeforeEth:
                    typeof floorBefore === 'number' && floorBefore > 0 ? floorBefore : null,
            });
            const delNar = await summarizeFactsWithOptionalAi({
                explanation: cxDel,
                jobCacheKey: eventId,
            });

            const { name: massDelistCollectionName } = await this.collectionNames.resolve(
                det.contract.toLowerCase(),
                { trackedName: row.name },
            );

            const impactRouteDel = await prisma.alertChannel.findUnique({
                where: {
                    guildId_alertType: { guildId: row.guildId, alertType: 'FLOOR_IMPACT_FOLLOWUP' },
                },
                select: { mentionRoleId: true },
            });
            const delistRoute = await prisma.alertChannel.findUnique({
                where: {
                    guildId_alertType: { guildId: row.guildId, alertType: 'MASS_DELIST' },
                },
                select: { mentionRoleId: true },
            });
            const delistPing = row.mentionRoleId ?? delistRoute?.mentionRoleId ?? null;

            await discordQueue.add(
                'discord_alert',
                {
                    eventId,
                    channelId,
                    alertType: 'MASS_DELIST',
                    contract: det.contract,
                    chain: det.chain,
                    collectionName: massDelistCollectionName,
                    collectionMeta,
                    delistCount: det.count,
                    windowMs: det.windowMs,
                    sampleOrderIds: det.sampleOrderIds,
                    mentionRoleId: delistPing,
                    floorBeforeEth: floorBefore,
                    floorImpactPending: true,
                    contextualExplanation: cxDel,
                    aiNarrative: delNar ?? undefined,
                },
                {
                    jobId: `mass-delist-${row.id}-${det.bucketStart}-${this.massDelistMinDefault}`,
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                },
            );

            await this.scheduleFloorImpact({
                eventId,
                channelId,
                alertType: 'MASS_DELIST',
                contract: det.contract,
                chain: det.chain,
                floorBefore,
                mentionRoleId: impactRouteDel?.mentionRoleId ?? null,
            });
        }
    }
}

if (require.main === module) {
    const svc = new MarketIndexer();
    svc.start().catch(err => {
        console.error('❌ Failed to start MarketIndexer:', err);
        process.exit(1);
    });
}
