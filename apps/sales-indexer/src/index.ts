import * as dotenv from 'dotenv';
import { eventQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import {
    AlchemySalesClient,
    ReservoirSalesClient,
    SalesProvider,
} from '@superbot/analytics';

dotenv.config();

/**
 * SalesIndexer — polls a normalized sales source (Alchemy or Reservoir) for
 * every tracked collection and publishes each sale into the shared event
 * queue, where the existing worker + bot pipeline takes over and delivers
 * Discord alerts.
 *
 * Provider selection (first match wins):
 *   1. Alchemy NFT Sales API — if `ALCHEMY_API_KEY` (or a key extractable
 *      from `WSS_RPC_URL`) is configured. Preferred because the operator
 *      already needs an Alchemy key for the WSS RPC.
 *   2. Reservoir `sales/v6` — if `RESERVOIR_API_KEY` is configured.
 *   3. Disabled. The service stays alive so Railway does not crash-loop.
 *
 * Idempotency: the provider's stable `eventId` is reused as the BullMQ jobId,
 * so duplicates seen across polling cycles are dropped at the queue layer.
 */
export class SalesIndexer {
    private provider: SalesProvider | null = null;
    private pollIntervalMs = Number(
        process.env.SALES_POLL_INTERVAL_MS || process.env.RESERVOIR_POLL_INTERVAL_MS,
    ) || 30_000;
    private timer: NodeJS.Timeout | null = null;

    // Per (chain:contract) cursor, opaque to us — the provider chooses what to
    // store (last block for Alchemy, last timestamp for Reservoir).
    private cursorByContract = new Map<string, string>();

    constructor() {
        const alchemy = new AlchemySalesClient();
        const reservoir = new ReservoirSalesClient();
        if (alchemy.isConfigured()) {
            this.provider = alchemy;
        } else if (reservoir.isConfigured()) {
            this.provider = reservoir;
        }
    }

    public async start() {
        if (!this.provider) {
            console.warn(
                '[SalesIndexer] No sales provider configured (set ALCHEMY_API_KEY or RESERVOIR_API_KEY). Sales indexer is disabled.',
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

        for (const { contract, chain } of unique.values()) {
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
                        jobId: sale.eventId,
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
}

if (require.main === module) {
    const svc = new SalesIndexer();
    svc.start().catch(err => {
        console.error('❌ Failed to start SalesIndexer:', err);
        process.exit(1);
    });
}
