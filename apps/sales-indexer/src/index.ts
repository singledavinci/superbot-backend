import { createHash } from 'crypto';
import * as dotenv from 'dotenv';
import { eventQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import {
    AlchemySalesClient,
    OpenSeaSalesClient,
    ReservoirSalesClient,
    SalesProvider,
    hotContractsSetKey,
} from '@superbot/analytics';
import { redisConnection } from '@superbot/queue';

dotenv.config();

/**
 * SalesIndexer — polls a normalized sales source for every tracked collection
 * and publishes each sale into the shared event queue, where the existing
 * worker + bot pipeline takes over and delivers Discord alerts.
 *
 * Provider selection (first configured wins; explicit preference via
 * `SALES_PROVIDER=opensea|reservoir|alchemy` overrides ordering):
 *   1. OpenSea v2 — most accurate marketplace data, requires `OPENSEA_API_KEY`.
 *   2. Reservoir — multi-marketplace aggregator, requires `RESERVOIR_API_KEY`.
 *   3. Alchemy NFT Sales — only useful on paid tiers (free tier returns a
 *      stale snapshot from 2024), requires `ALCHEMY_API_KEY`.
 *   4. Disabled. The service stays alive so Railway does not crash-loop;
 *      live sales still flow through the on-chain SaleDetector path.
 *
 * Idempotency: the provider's stable `eventId` is hashed for BullMQ `jobId`
 * (BullMQ forbids ":" in custom ids; OpenSea/Reservoir ids use ":"). Payload
 * still carries the original `eventId` for the worker pipeline.
 */
function bullMqJobId(eventId: string): string {
    return createHash('sha256').update(eventId, 'utf8').digest('hex');
}

export class SalesIndexer {
    private provider: SalesProvider | null = null;
    private pollIntervalMs = Number(
        process.env.SALES_POLL_INTERVAL_MS || process.env.RESERVOIR_POLL_INTERVAL_MS,
    ) || 30_000;
    private timer: NodeJS.Timeout | null = null;

    // Per (chain:contract) cursor, opaque to us — the provider chooses what to
    // store (last timestamp for OpenSea/Reservoir, last block for Alchemy).
    private cursorByContract = new Map<string, string>();

    constructor() {
        this.provider = this.pickProvider();
    }

    private pickProvider(): SalesProvider | null {
        const opensea = new OpenSeaSalesClient();
        const reservoir = new ReservoirSalesClient();
        const alchemy = new AlchemySalesClient();

        const explicit = (process.env.SALES_PROVIDER || '').trim().toLowerCase();
        const byName: Record<string, SalesProvider> = {
            opensea,
            reservoir,
            alchemy,
        };
        if (explicit && byName[explicit]) {
            const chosen = byName[explicit];
            if (chosen.isConfigured()) return chosen;
            console.warn(
                `[SalesIndexer] SALES_PROVIDER=${explicit} requested but not configured; falling back to auto-pick.`,
            );
        }

        if (opensea.isConfigured()) return opensea;
        if (reservoir.isConfigured()) return reservoir;
        if (alchemy.isConfigured()) return alchemy;
        return null;
    }

    public async start() {
        if (!this.provider) {
            console.warn(
                '[SalesIndexer] No sales provider configured (set OPENSEA_API_KEY, RESERVOIR_API_KEY, or ALCHEMY_API_KEY). Sales indexer is disabled — on-chain SaleDetector still delivers live sales.',
            );
            await new Promise(() => {});
            return;
        }

        console.log(
            `[SalesIndexer] Started with provider="${this.provider.name}". Polling every ${this.pollIntervalMs}ms.`,
        );
        await this.tick();
        this.timer = setInterval(() => {
            this.tick().catch(err => console.error('[SalesIndexer] tick error:', err));
        }, this.pollIntervalMs);
    }

    public async stop() {
        if (this.timer) clearInterval(this.timer);
    }

    private async tick() {
        if (!this.provider) return;

        try {
            const collections = await prisma.trackedCollection.findMany({
                select: { contractAddress: true, chain: true },
            });
            if (collections.length === 0) return;

            // Ethereum-only deployment: skip rows on other chains.
            const unique = new Map<string, { contract: string; chain: 'ethereum' }>();
            for (const c of collections) {
                const chain = (c.chain || 'ethereum').toLowerCase();
                if (chain !== 'ethereum') continue;
                const contract = c.contractAddress.toLowerCase();
                unique.set(`${chain}:${contract}`, { contract, chain: 'ethereum' });
            }

            let extraHot: string[] = [];
            try {
                extraHot = await redisConnection.smembers(hotContractsSetKey('ethereum'));
            } catch {
                extraHot = [];
            }
            for (const addr of extraHot) {
                if (typeof addr === 'string' && addr.startsWith('0x') && addr.length === 42) {
                    unique.set(`ethereum:${addr.toLowerCase()}`, { contract: addr.toLowerCase(), chain: 'ethereum' });
                }
            }

            for (const { contract, chain } of unique.values()) {
                try {
                    await this.tickContract(contract, chain);
                } catch (err) {
                    console.error(
                        `[SalesIndexer] (${this.provider.name}) tick failed for ${contract}:`,
                        err instanceof Error ? err.stack || err.message : err,
                    );
                }
            }
        } catch (err) {
            console.error(
                '[SalesIndexer] tick failed (db or setup):',
                err instanceof Error ? err.stack || err.message : err,
            );
        }
    }

    private async tickContract(contract: string, chain: 'ethereum') {
        if (!this.provider) return;

        const key = `${chain}:${contract}`;
        const cursor = this.cursorByContract.get(key);

        const result = await this.provider.fetchSales({
            contract,
            chain,
            cursor,
            limit: 50,
        });

        for (const sale of result.sales) {
            // Reuse the existing transfer event shape so the worker + bot
            // pipeline can ingest sales without changes. We tag as
            // `erc721_transfer` so it routes through `handleTransfer` and
            // triggers a SALE alert (price > 0, from/to non-zero).
            try {
                const tid = sale.tokenId != null ? String(sale.tokenId) : '';
                if (tid) {
                    await redisConnection.set(
                        `listing_trade_recent:${chain}:${contract}:${tid}`,
                        '1',
                        'EX',
                        300,
                    );
                }
            } catch {
                /* best-effort */
            }

            await eventQueue.add(
                'nft_transfer',
                {
                    eventId: sale.eventId,
                    type: 'erc721_transfer',
                    chain: sale.chain,
                    contract: sale.contract,
                    tokenId: sale.tokenId,
                    txHash: sale.txHash,
                    blockNumber: sale.blockNumber,
                    from: sale.seller,
                    to: sale.buyer,
                    priceNative: sale.priceNative,
                    priceUsd: sale.priceUsd,
                    currency: sale.currency,
                    marketplace: sale.marketplace,
                    timestamp: sale.timestamp,
                },
                {
                    jobId: bullMqJobId(sale.eventId),
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                },
            );
        }

        if (result.nextCursor) {
            this.cursorByContract.set(key, result.nextCursor);
        }

        if (result.sales.length > 0) {
            console.log(
                `[SalesIndexer] (${this.provider.name}) ${result.sales.length} sales for ${contract} -> queue (cursor=${result.nextCursor ?? 'unchanged'})`,
            );
        }
    }
}

if (require.main === module) {
    process.on('unhandledRejection', reason => {
        console.error('[sales-indexer] unhandledRejection:', reason);
    });
    process.on('uncaughtException', err => {
        console.error('[sales-indexer] uncaughtException:', err);
    });

    const svc = new SalesIndexer();
    svc.start().catch(err => {
        console.error('❌ Failed to start SalesIndexer:', err);
        process.exit(1);
    });
}
