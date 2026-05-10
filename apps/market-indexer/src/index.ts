import * as dotenv from 'dotenv';
import { discordQueue, redisConnection } from '@superbot/queue';
import { prisma } from '@superbot/database';
import {
    MassListingDetector,
    NFTMetadataClient,
    OpenSeaSalesClient,
    SalesProvider,
} from '@superbot/analytics';

dotenv.config();

/**
 * Polls OpenSea for floor snapshots + listing events per tracked contract (deduped),
 * writes floor readings to Redis for the floor-checker worker, and emits mass-listing alerts.
 *
 * Requires OPENSEA_API_KEY; without it the service stays idle (no mock data).
 */
export class MarketIndexer {
    private provider: SalesProvider | null = null;
    private detector = new MassListingDetector();
    /** Same collection enrichment pattern as EventWorker sweep/cluster alerts */
    private nftMetadata = new NFTMetadataClient({ redis: redisConnection });
    private pollIntervalMs = Number(process.env.MARKET_POLL_INTERVAL_MS) || 60_000;
    private timer: NodeJS.Timeout | null = null;
    private listingCursorByContract = new Map<string, string>();
    /** Per-contract minimum listing surge required (max of guild prefs). */
    private massListingMinByContract = new Map<string, number>();

    constructor() {
        const opensea = new OpenSeaSalesClient();
        this.provider = opensea.isConfigured() ? opensea : null;
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
            const minL =
                customs.length > 0 ? Math.min(...customs) : defaultMassMin;
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

                const cursor = this.listingCursorByContract.get(key);
                const result = await this.provider.fetchListings({
                    contract,
                    chain,
                    cursor,
                    limit: 50,
                });

                for (const listing of result.listings) {
                    const det = this.detector.ingest(listing, { minListings: minForContract });
                    if (det) {
                        await this.dispatchMassListing(det);
                    }
                }

                if (result.nextCursor) {
                    this.listingCursorByContract.set(key, result.nextCursor);
                }

                if (result.listings.length > 0) {
                    console.log(
                        `[MarketIndexer] ${result.listings.length} listing events for ${contract} (cursor=${result.nextCursor ?? 'unchanged'})`,
                    );
                }
            } catch (err) {
                console.error(`[MarketIndexer] Failed ${contract}:`, err);
            }
        }
    }

    private async dispatchMassListing(det: {
        bucketStart: number;
        chain: string;
        contract: string;
        count: number;
        windowMs: number;
    }) {
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

            await discordQueue.add(
                'discord_alert',
                {
                    eventId,
                    channelId: row.alertChannelId,
                    alertType: 'MASS_LISTING',
                    contract: det.contract,
                    chain: det.chain,
                    collectionName: collectionMeta?.name ?? row.name,
                    collectionMeta,
                    listingCount: det.count,
                    windowMs: det.windowMs,
                    mentionRoleId: row.mentionRoleId,
                },
                {
                    jobId: `mass-listing-${row.id}-${det.bucketStart}-${minListings}`,
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                },
            );
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
