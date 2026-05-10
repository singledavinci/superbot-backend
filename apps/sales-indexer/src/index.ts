import * as dotenv from 'dotenv';
import { eventQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import { ReservoirSalesClient } from '@superbot/analytics';

dotenv.config();

/**
 * SalesIndexer — polls Reservoir for normalized sales of every tracked
 * collection and publishes them into the shared event queue so the
 * existing worker + bot pipeline can deliver alerts.
 *
 * Idempotency: Reservoir's stable `eventId` is reused as BullMQ jobId,
 * which means duplicate sales detected across polling cycles are dropped
 * by the queue itself (as long as the previous job is still retained).
 */
export class SalesIndexer {
    private reservoir = new ReservoirSalesClient();
    private pollIntervalMs = Number(process.env.RESERVOIR_POLL_INTERVAL_MS) || 30_000;
    private timer: NodeJS.Timeout | null = null;
    private lastSeenByContract = new Map<string, number>();

    public async start() {
        if (!this.reservoir.isConfigured()) {
            console.warn('[SalesIndexer] RESERVOIR_API_KEY not configured; sales indexer is disabled.');
            // Stay alive so the service does not crash-loop on Railway, but do nothing.
            await new Promise(() => {});
            return;
        }

        console.log(`[SalesIndexer] Started. Polling every ${this.pollIntervalMs}ms.`);
        await this.tick();
        this.timer = setInterval(() => {
            this.tick().catch(err => console.error('[SalesIndexer] tick error:', err));
        }, this.pollIntervalMs);
    }

    public async stop() {
        if (this.timer) clearInterval(this.timer);
    }

    private async tick() {
        const collections = await prisma.trackedCollection.findMany({
            select: { contractAddress: true, chain: true }
        });

        if (collections.length === 0) return;

        // De-duplicate by (chain, contract) since multiple guilds may track the same contract.
        const unique = new Map<string, { contract: string; chain: string }>();
        for (const c of collections) {
            const chain = (c.chain || 'ethereum').toLowerCase();
            const contract = c.contractAddress.toLowerCase();
            unique.set(`${chain}:${contract}`, { contract, chain });
        }

        for (const { contract, chain } of unique.values()) {
            const key = `${chain}:${contract}`;
            const sinceUnix = this.lastSeenByContract.get(key);

            const sales = await this.reservoir.fetchSalesForContract(contract, {
                chain: chain as 'ethereum' | 'base' | 'polygon' | 'arbitrum' | 'optimism',
                sinceUnix,
                limit: 50,
            });

            if (sales.length === 0) continue;

            let maxTs = sinceUnix ?? 0;
            for (const sale of sales) {
                if (sale.timestamp > maxTs) maxTs = sale.timestamp;

                // Reuse the existing transfer event shape so the worker + bot pipeline
                // can ingest these without changes. We pass `type: 'erc721_transfer'`
                // so it routes through `handleTransfer` and triggers a SALE alert
                // (because price > 0 and from/to are non-zero).
                await eventQueue.add('nft_transfer', {
                    eventId: sale.eventId,
                    type: 'erc721_transfer',
                    chain: sale.chain,
                    contract: sale.contract,
                    tokenId: sale.tokenId,
                    txHash: sale.txHash,
                    blockNumber: undefined,
                    from: sale.seller,
                    to: sale.buyer,
                    // Hints for downstream code if/when it consumes them:
                    priceNative: sale.priceNative,
                    priceUsd: sale.priceUsd,
                    currency: sale.currency,
                    marketplace: sale.marketplace,
                    timestamp: sale.timestamp,
                }, {
                    jobId: sale.eventId,                    // idempotent at the queue layer
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                });
            }

            this.lastSeenByContract.set(key, maxTs + 1);
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
