import type { NormalizedSale } from './SalesProvider';

export interface ClusterBuyDetection {
    /** Deterministic idempotency key. */
    eventId: string;
    chain: string;
    contract: string;
    /** Internal Prisma Guild.id */
    guildDbId: string;
    /** Distinct tracked buyers in the window (lowercase). */
    buyers: string[];
    triggerTxHash: string;
    triggerBuyer: string;
    /** NFT that triggered cluster detection when the sale payload includes tokenId */
    triggerTokenId?: string;
    windowMs: number;
}

function tsMs(s: NormalizedSale): number {
    if (!s.timestamp) return Date.now();
    return s.timestamp > 1e12 ? s.timestamp : s.timestamp * 1000;
}

/**
 * When N distinct tracked wallets buy the same collection within a sliding window,
 * emit at most one detection per (guild, contract, trigger tx, trigger buyer).
 */
export class SmartMoneyClusterDetector {
    private windows = new Map<string, { buyer: string; tsMs: number }[]>();
    private emitted = new Set<string>();

    private cfg() {
        return {
            windowMs: Number(process.env.CLUSTER_WINDOW_MS) || 30 * 60 * 1000,
            minWallets: Math.max(2, Number(process.env.CLUSTER_MIN_WALLETS) || 2),
        };
    }

    ingest(sale: NormalizedSale, guildDbId: string): ClusterBuyDetection | null {
        const { windowMs, minWallets } = this.cfg();
        if (!sale.priceNative || sale.priceNative <= 0) return null;

        const buyer = (sale.buyer || '').toLowerCase();
        if (!buyer || buyer === '0x0000000000000000000000000000000000000000') return null;

        const chain = (sale.chain || 'ethereum').toLowerCase();
        const contract = (sale.contract || '').toLowerCase();
        const key = `${guildDbId}:${contract}`;

        const now = Date.now();
        const cutoff = now - windowMs;
        const buf = this.windows.get(key) ?? [];
        buf.push({ buyer, tsMs: tsMs(sale) });
        const pruned = buf.filter(e => e.tsMs >= cutoff);
        this.windows.set(key, pruned);

        const distinct = [...new Set(pruned.map(e => e.buyer))];
        if (distinct.length < minWallets) return null;

        const eventId = `cluster-buy:${chain}:${contract}:${guildDbId}:${sale.txHash}:${buyer}`;
        if (this.emitted.has(eventId)) return null;
        this.emitted.add(eventId);

        return {
            eventId,
            chain,
            contract,
            guildDbId,
            buyers: distinct.sort(),
            triggerTxHash: sale.txHash,
            triggerBuyer: buyer,
            triggerTokenId:
                sale.tokenId !== undefined &&
                sale.tokenId !== null &&
                String(sale.tokenId).trim().length > 0
                    ? String(sale.tokenId).trim()
                    : undefined,
            windowMs,
        };
    }
}
