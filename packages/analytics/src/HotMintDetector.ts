export interface HotMintIngestEvent {
    chain: string;
    contract: string;
    minter: string;
    blockNumber?: number;
    tsMs: number;
}

export interface HotMintDetection {
    eventId: string;
    chain: string;
    contract: string;
    windowStartBucket: number;
    uniqueMinters: number;
    totalMints: number;
    blockMin: number;
    blockMax: number;
    windowMs: number;
    topMinters: Array<{ address: string; count: number }>;
}

interface Entry {
    minter: string;
    blockNumber: number;
    tsMs: number;
}

/**
 * Tracks mints (Transfer from 0x0) per (chain, contract) in a sliding window.
 * Defaults: HOT_MINT_MIN_UNIQUE_MINTERS=15, HOT_MINT_MIN_TOTAL_MINTS=25, HOT_MINT_WINDOW_MS=600_000.
 * eventId: hotmint:<chain>:<contract>:<windowStartBucket>
 */
export class HotMintDetector {
    private windows = new Map<string, Entry[]>();

    private cfg() {
        return {
            windowMs: Number(process.env.HOT_MINT_WINDOW_MS) || 10 * 60 * 1000,
            minUnique: Number(process.env.HOT_MINT_MIN_UNIQUE_MINTERS) || 15,
            minTotal: Number(process.env.HOT_MINT_MIN_TOTAL_MINTS) || 25,
        };
    }

    ingest(ev: HotMintIngestEvent): HotMintDetection | null {
        const chain = (ev.chain || 'ethereum').toLowerCase();
        if (chain !== 'ethereum') return null;

        const contract = (ev.contract || '').toLowerCase();
        const minter = (ev.minter || '').toLowerCase();
        if (!contract || !minter) return null;

        const { windowMs, minUnique, minTotal } = this.cfg();
        const mapKey = `${chain}:${contract}`;
        const ts = ev.tsMs > 0 ? ev.tsMs : Date.now();
        const block = ev.blockNumber ?? 0;

        const buf = this.windows.get(mapKey) ?? [];
        buf.push({ minter, blockNumber: block, tsMs: ts });
        const cutoff = ts - windowMs;
        const pruned = buf.filter(e => e.tsMs >= cutoff);
        this.windows.set(mapKey, pruned);

        const uniq = new Set(pruned.map(e => e.minter));
        if (uniq.size < minUnique || pruned.length < minTotal) return null;

        const oldestTs = Math.min(...pruned.map(e => e.tsMs));
        const windowStartBucket = Math.floor(oldestTs / windowMs) * windowMs;

        const counts = new Map<string, number>();
        for (const e of pruned) {
            counts.set(e.minter, (counts.get(e.minter) ?? 0) + 1);
        }
        const topMinters = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([address, count]) => ({ address, count }));

        const blocks = pruned.map(e => e.blockNumber).filter(b => b > 0);
        const blockMin = blocks.length ? Math.min(...blocks) : 0;
        const blockMax = blocks.length ? Math.max(...blocks) : 0;

        const eventId = `hotmint:${chain}:${contract}:${windowStartBucket}`;

        return {
            eventId,
            chain,
            contract,
            windowStartBucket,
            uniqueMinters: uniq.size,
            totalMints: pruned.length,
            blockMin,
            blockMax,
            windowMs,
            topMinters,
        };
    }
}
