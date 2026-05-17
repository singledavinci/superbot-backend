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
    markOpportunityHotContract,
    type RpcPool,
} from '@superbot/analytics';
import type { NormalizedListing } from '@superbot/analytics';
import { OpportunityMonitorRunner } from './opportunityMonitor';
import {
    explainMassListing,
    explainMassDelist,
    summarizeFactsWithOptionalAi,
} from '@superbot/intelligence';
import { resolveAlertRoute, type AlertChannelRow } from '@superbot/types';

dotenv.config();

const FLOOR_IMPACT_DELAY_MS = Number(process.env.FLOOR_IMPACT_DELAY_MS) || 10 * 60 * 1000;

const LISTING_SNAPSHOT_MAX = 500;
const MAX_INFERRED_DELIST_LOOKUPS_PER_TICK = 50;
const MASS_DELIST_INFER_FROM_LISTINGS = process.env.MASS_DELIST_INFER_FROM_LISTINGS !== 'false';

function formatListingSnapshotKey(l: NormalizedListing): string {
    const tid = (l.tokenId ?? '?').toString();
    const maker = (l.maker ?? '').toLowerCase();
    const price = Number.isFinite(l.priceNative) ? l.priceNative.toFixed(8) : '0';
    return `${tid}|${maker}|${price}`;
}

function parseListingSnapshotKey(key: string): { tokenId: string; maker: string; priceNative: number } | null {
    const first = key.indexOf('|');
    if (first <= 0) return null;
    const second = key.indexOf('|', first + 1);
    if (second <= first) return null;
    const tokenId = key.slice(0, first);
    const maker = key.slice(first + 1, second);
    const priceStr = key.slice(second + 1);
    const priceNative = Number(priceStr);
    return {
        tokenId,
        maker,
        priceNative: Number.isFinite(priceNative) ? priceNative : 0,
    };
}


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
    private opportunityTimer: NodeJS.Timeout | null = null;
    private opportunityRunner: OpportunityMonitorRunner | null = null;

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
        process.on('uncaughtException', err => {
            console.error('[MarketIndexer] uncaughtException:', err instanceof Error ? err.stack || err.message : err);
        });
        process.on('unhandledRejection', reason => {
            console.error(
                '[MarketIndexer] unhandledRejection:',
                reason instanceof Error ? reason.stack || reason.message : reason,
            );
        });

        if (process.env.OPPORTUNITY_MONITOR_ENABLED !== 'false') {
            this.opportunityRunner = new OpportunityMonitorRunner(redisConnection);
            const sec = Number(process.env.OPPORTUNITY_MONITOR_INTERVAL_SECONDS);
            const oppMs = (Number.isFinite(sec) && sec > 0 ? sec : 120) * 1000;
            this.opportunityTimer = setInterval(() => {
                this.opportunityRunner
                    ?.evaluateAndDispatch()
                    .catch(err => console.error('[OpportunityMonitor] tick error:', err));
            }, oppMs);
            this.opportunityRunner.evaluateAndDispatch().catch(err => console.error('[OpportunityMonitor] boot error:', err));
            console.log(`[MarketIndexer] Opportunity monitor scheduled every ${oppMs / 1000}s (Redis + DB).`);
        }

        if (!this.provider) {
            console.warn(
                '[MarketIndexer] OPENSEA_API_KEY not set — listing/floor polling idle (no synthetic data). Opportunity monitor (if enabled) still runs on Redis/DB.',
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
        if (this.opportunityTimer) clearInterval(this.opportunityTimer);
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

                const lc = contract.toLowerCase();
                const listCount = listingResult.listings.length;
                try {
                    const prevK = `opportunity:listings_prev:${lc}`;
                    const prev = await redisConnection.get(prevK);
                    if (prev !== null && prev !== '') {
                        await redisConnection.set(
                            `opportunity:listings_delta:${lc}`,
                            String(listCount - Number(prev)),
                            'EX',
                            900,
                        );
                    }
                    await redisConnection.set(prevK, String(listCount), 'EX', 900);
                } catch {
                    /* ignore */
                }

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
                        await markOpportunityHotContract(redisConnection, det.chain, det.contract).catch(() => {});
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

                if (MASS_DELIST_INFER_FROM_LISTINGS) {
                    await this.applyListingSnapshotAndInferDelists({
                        chain,
                        contract,
                        listings: listingResult.listings,
                        floorBefore,
                    });
                } else {
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
                            await markOpportunityHotContract(redisConnection, del.chain, del.contract).catch(() => {});
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
                }
            } catch (err) {
                console.error(`[MarketIndexer] Failed ${contract}:`, err);
            }
        }
    }

    private async applyListingSnapshotAndInferDelists(args: {
        chain: string;
        contract: string;
        listings: NormalizedListing[];
        floorBefore: number | null;
    }): Promise<void> {
        const { chain, contract, listings, floorBefore } = args;
        const ch = (chain || 'ethereum').toLowerCase();
        const c = contract.toLowerCase();
        const redisKey = `listings:${ch}:${c}:current`;
        let prevKeys: string[] = [];
        try {
            const raw = await redisConnection.get(redisKey);
            if (raw) {
                const parsed = JSON.parse(raw) as unknown;
                if (Array.isArray(parsed)) {
                    prevKeys = parsed.filter((x): x is string => typeof x === 'string');
                }
            }
        } catch {
            prevKeys = [];
        }

        const nextKeys = listings.slice(0, LISTING_SNAPSHOT_MAX).map(formatListingSnapshotKey);
        const nextSet = new Set(nextKeys);
        let inferred = 0;
        let lookedUp = 0;

        if (prevKeys.length > 0) {
            for (const k of prevKeys) {
                if (nextSet.has(k)) continue;
                if (lookedUp >= MAX_INFERRED_DELIST_LOOKUPS_PER_TICK) break;

                const parsed = parseListingSnapshotKey(k);
                if (!parsed || !parsed.tokenId || parsed.tokenId === '?') continue;

                lookedUp += 1;

                try {
                    const tradeRecent = await redisConnection.get(
                        `listing_trade_recent:${ch}:${c}:${parsed.tokenId}`,
                    );
                    if (tradeRecent === '1') continue;
                } catch {
                    /* ignore redis errors */
                }

                const since = new Date(Date.now() - 5 * 60 * 1000);
                const saleHit = await prisma.alertDeliveryLog.findFirst({
                    where: {
                        createdAt: { gte: since },
                        alertType: { in: ['WHALE_SALE', 'WHALE_BUY'] },
                        status: 'delivered',
                        eventId: { contains: parsed.tokenId },
                    },
                    select: { id: true },
                });
                if (saleHit) continue;

                const synthetic: NormalizedListing = {
                    eventId: `inferred-cancel:${ch}:${c}:${parsed.tokenId}:${Date.now()}:${inferred}`,
                    chain: ch,
                    contract: c,
                    tokenId: parsed.tokenId,
                    timestamp: Math.floor(Date.now() / 1000),
                    maker: parsed.maker,
                    priceNative: parsed.priceNative,
                    currency: 'ETH',
                    marketplace: 'OpenSea',
                    raw: { inferredCancellation: true, priorListingKey: k },
                };
                const del = this.delistDetector.ingest(synthetic, {
                    minCancels: this.massDelistMinDefault,
                });
                if (del) {
                    await markOpportunityHotContract(redisConnection, del.chain, del.contract).catch(() => {});
                    await this.dispatchMassDelist(del, floorBefore);
                }
                inferred += 1;
            }
            if (inferred > 0) {
                console.log(
                    `[MarketIndexer] inferred ${inferred} cancellation(s) for ${c} (listing snapshot diff)`,
                );
            }
        }

        try {
            await redisConnection.set(redisKey, JSON.stringify(nextKeys), 'EX', 86400);
        } catch {
            /* best-effort */
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

        const guildIdsListing = [...new Set(rows.map(r => r.guildId))];
        const guildsListing = await prisma.guild.findMany({
            where: { id: { in: guildIdsListing } },
            include: { alertChannels: true },
        });
        const guildByIdListing = new Map(guildsListing.map(g => [g.id, g]));

        for (const row of rows) {
            const minListings = row.massListingThreshold ?? defaultMin;
            if (det.count < minListings) continue;

            const gListing = guildByIdListing.get(row.guildId);
            const listingRoute = resolveAlertRoute(
                (gListing?.alertChannels ?? []) as AlertChannelRow[],
                'MASS_LISTING',
                { hypothesisId: 'A', debug: process.env.DEBUG_ALERT_ROUTING === 'true' },
            );
            const channelId = listingRoute.channelId;
            if (!channelId) continue;

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

            const impactRoute = resolveAlertRoute(
                (gListing?.alertChannels ?? []) as AlertChannelRow[],
                'FLOOR_IMPACT_FOLLOWUP',
            );

            await discordQueue.add(
                'discord_alert',
                {
                    eventId,
                    channelId,
                    alertType: 'MASS_LISTING',
                    contract: det.contract,
                    chain: det.chain,
                    collectionName: massListingCollectionName,
                    collectionMeta,
                    listingCount: det.count,
                    windowMs: det.windowMs,
                    mentionRoleId: listingRoute.mentionRoleId,
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
                channelId,
                alertType: 'MASS_LISTING',
                contract: det.contract,
                chain: det.chain,
                floorBefore,
                mentionRoleId: impactRoute.mentionRoleId,
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

        const guildIdsDelist = [...new Set(rows.map(r => r.guildId))];
        const guildsDelist = await prisma.guild.findMany({
            where: { id: { in: guildIdsDelist } },
            include: { alertChannels: true },
        });
        const guildByIdDelist = new Map(guildsDelist.map(g => [g.id, g]));

        for (const row of rows) {
            if (row.delistAlertEnabled === false) continue;
            if (det.count < this.massDelistMinDefault) continue;

            const gDelist = guildByIdDelist.get(row.guildId);
            const delistRoute = resolveAlertRoute(
                (gDelist?.alertChannels ?? []) as AlertChannelRow[],
                'MASS_DELIST',
                {
                    channelOverride: row.delistChannelId,
                    hypothesisId: 'A',
                    debug: process.env.DEBUG_ALERT_ROUTING === 'true',
                },
            );
            const channelId = delistRoute.channelId;
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

            const impactRouteDel = resolveAlertRoute(
                (gDelist?.alertChannels ?? []) as AlertChannelRow[],
                'FLOOR_IMPACT_FOLLOWUP',
            );

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
                    mentionRoleId: delistRoute.mentionRoleId,
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
                mentionRoleId: impactRouteDel.mentionRoleId,
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
