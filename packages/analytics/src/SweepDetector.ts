import type { NormalizedSale } from './SalesProvider';

export interface SweepDetection {
    /** Deterministic idempotency key (includes chain/contract/tx/buyer). */
    eventId: string;
    txHash: string;
    buyer: string;
    chain: string;
    contract: string;
    itemCount: number;
    totalNative: number;
    currency: string;
    tokenIds: string[];
}

function tsMs(s: NormalizedSale): number {
    if (!s.timestamp) return Date.now();
    return s.timestamp > 1e12 ? s.timestamp : s.timestamp * 1000;
}

/**
 * Stateful analyzer for floor sweeps: multiple buys in one transaction (same buyer).
 * Thresholds: SWEEP_MIN_ITEMS, SWEEP_MIN_TOTAL_NATIVE, SWEEP_WINDOW_MS.
 */
export class SweepDetector {
    private windows = new Map<string, NormalizedSale[]>();
    private emitted = new Set<string>();

    private cfg() {
        return {
            windowMs: Number(process.env.SWEEP_WINDOW_MS) || 90_000,
            minItems: Number(process.env.SWEEP_MIN_ITEMS) || 3,
            minTotalNative: Number(process.env.SWEEP_MIN_TOTAL_NATIVE) || 0.5,
        };
    }

    /**
     * Ingest one sale; returns a sweep detection at most once per unique (chain, contract, tx, buyer).
     */
    ingest(sale: NormalizedSale): SweepDetection | null {
        const { windowMs, minItems, minTotalNative } = this.cfg();

        if (!sale.priceNative || sale.priceNative <= 0) return null;
        const buyer = (sale.buyer || '').toLowerCase();
        if (!buyer || buyer === '0x0000000000000000000000000000000000000000') return null;

        const chain = (sale.chain || 'ethereum').toLowerCase();
        const contract = (sale.contract || '').toLowerCase();
        const key = `${chain}:${contract}`;

        const now = Date.now();
        const cutoff = now - windowMs;

        const buf = this.windows.get(key) ?? [];
        buf.push(sale);
        const pruned = buf.filter(s => tsMs(s) >= cutoff);
        this.windows.set(key, pruned);

        const sep = '\x1f';
        const groups = new Map<string, NormalizedSale[]>();
        for (const s of pruned) {
            const tx = (s.txHash || '').toLowerCase();
            const b = (s.buyer || '').toLowerCase();
            if (!tx || !b) continue;
            const gk = `${tx}${sep}${b}`;
            const g = groups.get(gk) ?? [];
            g.push(s);
            groups.set(gk, g);
        }

        for (const [gk, sales] of groups) {
            const distinctBuyers = new Set(sales.map(s => (s.buyer || '').toLowerCase()));
            if (distinctBuyers.size !== 1) continue;

            const sum = sales.reduce((a, s) => a + (s.priceNative || 0), 0);
            if (sales.length < minItems || sum < minTotalNative) continue;

            const [txHash, aggBuyer] = gk.split(sep);
            const eventId = `sweep:${chain}:${contract}:${txHash}:${aggBuyer}`;

            if (this.emitted.has(eventId)) continue;
            this.emitted.add(eventId);

            return {
                eventId,
                txHash: sales[0]!.txHash,
                buyer: aggBuyer,
                chain,
                contract,
                itemCount: sales.length,
                totalNative: sum,
                currency: sales[0]?.currency ?? 'ETH',
                tokenIds: sales.map(s => s.tokenId ?? '').filter(Boolean),
            };
        }

        return null;
    }
}
