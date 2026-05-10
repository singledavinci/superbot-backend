import type Redis from 'ioredis';

const FS = '\x1f';

export interface HotMintIngestEvent {
    chain: string;
    contract: string;
    minter: string;
    blockNumber?: number;
    tsMs: number;
    /** Stable id per chain log (e.g. indexer eventId); required for Redis path deduplication. */
    eventId?: string;
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
 *
 * **Production:** pass a Redis client so all worker replicas share the same
 * window counters (in-memory state alone resets per process and splits traffic
 * across replicas).
 *
 * Defaults (when env unset): HOT_MINT_MIN_UNIQUE_MINTERS=5, HOT_MINT_MIN_TOTAL_MINTS=10,
 * HOT_MINT_WINDOW_MS=300_000 (5 minutes).
 *
 * Verbose logs: HOT_MINT_DEBUG=true (off by default).
 *
 * eventId: hotmint:<chain>:<contract>:<windowStartBucket>
 */
export class HotMintDetector {
    private windows = new Map<string, Entry[]>();
    private redis: Redis | null;

    constructor(redis?: Redis | null) {
        this.redis = redis ?? null;
    }

    private cfg() {
        return {
            windowMs: Number(process.env.HOT_MINT_WINDOW_MS) || 5 * 60 * 1000,
            minUnique: Number(process.env.HOT_MINT_MIN_UNIQUE_MINTERS) || 5,
            minTotal: Number(process.env.HOT_MINT_MIN_TOTAL_MINTS) || 10,
        };
    }

    private debugEnabled(): boolean {
        return process.env.HOT_MINT_DEBUG === 'true' || process.env.HOT_MINT_DEBUG === '1';
    }

    /**
     * In-memory only (tests / single-replica). Prefer {@link ingestAsync} when Redis is configured.
     */
    ingest(ev: HotMintIngestEvent): HotMintDetection | null {
        if (this.redis) {
            throw new Error('HotMintDetector: Redis is configured — use ingestAsync()');
        }
        return this.ingestInMemory(ev);
    }

    async ingestAsync(ev: HotMintIngestEvent): Promise<HotMintDetection | null> {
        if (!this.redis) {
            return this.ingestInMemory(ev);
        }
        return this.ingestRedis(this.redis, ev);
    }

    private ingestInMemory(ev: HotMintIngestEvent): HotMintDetection | null {
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

        return this.buildDetection(chain, contract, pruned, windowMs, minUnique, minTotal);
    }

    private async ingestRedis(r: Redis, ev: HotMintIngestEvent): Promise<HotMintDetection | null> {
        const chain = (ev.chain || 'ethereum').toLowerCase();
        if (chain !== 'ethereum') return null;

        const contract = (ev.contract || '').toLowerCase();
        const minter = (ev.minter || '').toLowerCase();
        if (!contract || !minter) return null;

        const { windowMs, minUnique, minTotal } = this.cfg();
        const ts = ev.tsMs > 0 ? ev.tsMs : Date.now();
        const block = ev.blockNumber ?? 0;
        const dedupeKey =
            ev.eventId && ev.eventId.trim().length > 0
                ? ev.eventId.trim()
                : `${minter}:${block}:${ts}`;
        const member = `${dedupeKey}${FS}${minter}${FS}${block}`;
        const zkey = `hotmint:z:${chain}:${contract}`;
        const cutoff = ts - windowMs;

        const pipe = r.multi();
        pipe.zadd(zkey, ts, member);
        pipe.zremrangebyscore(zkey, '-inf', cutoff);
        pipe.zrange(zkey, 0, -1, 'WITHSCORES');
        pipe.expire(zkey, Math.max(120, Math.ceil(windowMs / 1000) * 4));
        const exec = await pipe.exec();
        if (!exec) return null;

        const flat = exec[2]?.[1] as string[] | undefined;
        if (!Array.isArray(flat)) return null;

        const pruned: Entry[] = [];
        for (let i = 0; i < flat.length; i += 2) {
            const row = flat[i];
            const scoreMs = Number(flat[i + 1]);
            const parts = String(row).split(FS);
            if (parts.length < 3) continue;
            const m = parts[1]?.toLowerCase();
            const b = Number(parts[2]);
            if (!m) continue;
            pruned.push({
                minter: m,
                blockNumber: Number.isFinite(b) ? b : 0,
                tsMs: Number.isFinite(scoreMs) ? scoreMs : ts,
            });
        }

        const det = this.buildDetection(chain, contract, pruned, windowMs, minUnique, minTotal);

        if (this.debugEnabled()) {
            const uniq = new Set(pruned.map(e => e.minter));
            console.log(
                `[HotMint] window ${chain}:${contract.slice(0, 10)}… → ${uniq.size} minters, ${pruned.length} mints (need ≥${minUnique} / ≥${minTotal} in ${Math.round(windowMs / 60000)}m)`,
            );
        }

        return det;
    }

    private buildDetection(
        chain: string,
        contract: string,
        pruned: Entry[],
        windowMs: number,
        minUnique: number,
        minTotal: number,
    ): HotMintDetection | null {
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

        if (this.debugEnabled()) {
            console.log(
                `[HotMint] THRESHOLD MET ${chain}:${contract.slice(0, 10)}… → ${uniq.size} minters, ${pruned.length} mints — fire ${eventId}`,
            );
        }

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
