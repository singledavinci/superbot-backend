import type { NormalizedListing } from './SalesProvider';

export interface MassDelistDetection {
    bucketStart: number;
    chain: string;
    contract: string;
    count: number;
    windowMs: number;
    /** Up to 5 stable order/token identifiers from the surge window */
    sampleOrderIds: string[];
}

function tsMs(l: NormalizedListing): number {
    if (!l.timestamp) return Date.now();
    return l.timestamp > 1e12 ? l.timestamp : l.timestamp * 1000;
}

export interface MassDelistIngestOpts {
    minCancels?: number;
}

/**
 * Sliding-window detector for listing cancellations (delists) on a collection.
 * Defaults: MASS_DELIST_MIN_COUNT=8, MASS_DELIST_WINDOW_MS=1_800_000 (30 min).
 */
export class MassDelistDetector {
    private windows = new Map<string, NormalizedListing[]>();

    private cfg() {
        return {
            windowMs: Number(process.env.MASS_DELIST_WINDOW_MS) || 30 * 60 * 1000,
            minCancels: Number(process.env.MASS_DELIST_MIN_COUNT) || 8,
        };
    }

    ingest(cancel: NormalizedListing, opts?: MassDelistIngestOpts): MassDelistDetection | null {
        const { windowMs } = this.cfg();
        const minCancels = opts?.minCancels ?? this.cfg().minCancels;
        const chain = (cancel.chain || 'ethereum').toLowerCase();
        const contract = (cancel.contract || '').toLowerCase();
        const mapKey = `${chain}:${contract}`;

        const now = Date.now();
        const cutoff = now - windowMs;

        const buf = this.windows.get(mapKey) ?? [];
        buf.push(cancel);
        const pruned = buf.filter(l => tsMs(l) >= cutoff);
        this.windows.set(mapKey, pruned);

        if (pruned.length < minCancels) return null;

        const oldest = Math.min(...pruned.map(l => tsMs(l)));
        const bucketStart = Math.floor(oldest / windowMs) * windowMs;

        const sampleOrderIds: string[] = [];
        for (let i = pruned.length - 1; i >= 0 && sampleOrderIds.length < 5; i--) {
            const l = pruned[i]!;
            const id = l.orderHash || l.tokenId || l.eventId;
            if (id && !sampleOrderIds.includes(id)) sampleOrderIds.push(id);
        }

        return {
            bucketStart,
            chain,
            contract,
            count: pruned.length,
            windowMs,
            sampleOrderIds,
        };
    }
}
