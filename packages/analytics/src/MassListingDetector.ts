import type { NormalizedListing } from './SalesProvider';

export interface MassListingDetection {
    /** Rolling window start used for bucketing (epoch ms). */
    bucketStart: number;
    chain: string;
    contract: string;
    count: number;
    windowMs: number;
}

function tsMs(l: NormalizedListing): number {
    if (!l.timestamp) return Date.now();
    return l.timestamp > 1e12 ? l.timestamp : l.timestamp * 1000;
}

export interface MassListingIngestOpts {
    /** Per-(chain,contract) minimum count (e.g. max of guild overrides). */
    minListings?: number;
}

/**
 * Sliding-window surge detector for new listings on a collection.
 * Defaults: MASS_LISTING_MIN_COUNT=8, MASS_LISTING_WINDOW_MS=300000 (5 min).
 * Emits at most once per (chain, contract, window bucket).
 */
export class MassListingDetector {
    private windows = new Map<string, NormalizedListing[]>();

    private cfg() {
        return {
            windowMs: Number(process.env.MASS_LISTING_WINDOW_MS) || 5 * 60 * 1000,
            minListings: Number(process.env.MASS_LISTING_MIN_COUNT) || 8,
        };
    }

    ingest(listing: NormalizedListing, opts?: MassListingIngestOpts): MassListingDetection | null {
        const { windowMs } = this.cfg();
        const minListings = opts?.minListings ?? this.cfg().minListings;
        const chain = (listing.chain || 'ethereum').toLowerCase();
        const contract = (listing.contract || '').toLowerCase();
        const mapKey = `${chain}:${contract}`;

        const now = Date.now();
        const cutoff = now - windowMs;

        const buf = this.windows.get(mapKey) ?? [];
        buf.push(listing);
        const pruned = buf.filter(l => tsMs(l) >= cutoff);
        this.windows.set(mapKey, pruned);

        if (pruned.length < minListings) return null;

        const oldest = Math.min(...pruned.map(l => tsMs(l)));
        const bucketStart = Math.floor(oldest / windowMs) * windowMs;

        return {
            bucketStart,
            chain,
            contract,
            count: pruned.length,
            windowMs,
        };
    }
}
