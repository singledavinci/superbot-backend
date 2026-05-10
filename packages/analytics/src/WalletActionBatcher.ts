import type IORedis from 'ioredis';
import type { Queue } from 'bullmq';
import crypto from 'crypto';

/** Normalized whale behavior keys (sell mapped to sale per routing spec). */
export type WalletActionBatchBehaviorKey = 'buy' | 'sale' | 'mint';

export interface WhaleBatchStoredDiscordPayload extends Record<string, unknown> {
    eventId?: string;
    channelId?: string;
    alertType?: string;
    trackedWalletDbId?: string;
    chain?: string;
}

export interface WhaleActionBatchStoredEvent {
    version: 1;
    discordPayload: WhaleBatchStoredDiscordPayload;
    /** Serialized WhaleContextMetrics for intelligence merge at flush time (worker casts). */
    whaleMetricsJson: Record<string, unknown>;
    focalWalletLc: string;
    firstSeenAtCandidate: number;
    enqueuedAtMs: number;
    priceNative: number;
    blockNumber?: number;
    txHash: string;
    tokenId: string;
    marketplace?: string;
}

function batchFlushJobId(batchBase: string): string {
    const h = crypto.createHash('sha256').update(batchBase).digest('hex').slice(0, 32);
    return `flush:wab:${h}`;
}

export interface WalletActionBatcherOptions {
    enabled: boolean;
    flushMs: number;
    maxItems: number;
    onFlushBatch: (batchBase: string) => void | Promise<void>;
}

const DRAIN_EVENTS_LUA = [
    'local raw = redis.call("LRANGE", KEYS[1], 0, -1)',
    'redis.call("DEL", KEYS[1])',
    'redis.call("DEL", KEYS[2])',
    'return raw',
].join('\n');

export function buildWalletActionBatchBase(args: {
    chainLc: string;
    contractLc: string;
    guildDbId: string;
    walletLc: string;
    behavior: WalletActionBatchBehaviorKey;
}): string {
    return `batch:wallet_action:${args.chainLc.toLowerCase()}:${args.contractLc.toLowerCase()}:${args.guildDbId}:${args.walletLc.toLowerCase()}:${args.behavior}`;
}

export function whaleBatchListKey(batchBase: string): string {
    return `${batchBase}:events`;
}

export function whaleBatchMetaKey(batchBase: string): string {
    return `${batchBase}:meta`;
}

export function deterministicWalletBatchEventId(args: {
    chainLc: string;
    contractLc: string;
    walletLc: string;
    behavior: WalletActionBatchBehaviorKey;
    firstSeenAtMs: number;
}): string {
    const bucketMs = Math.floor(args.firstSeenAtMs / 60_000) * 60_000;
    return `wallet_batch:${args.chainLc.toLowerCase()}:${args.contractLc.toLowerCase()}:${args.walletLc.toLowerCase()}:${args.behavior}:${bucketMs}`;
}

export function mapEngineBehaviorToBatchKey(b: 'buy' | 'sell' | 'mint'): WalletActionBatchBehaviorKey {
    return b === 'sell' ? 'sale' : b;
}

export function parseStoredWhaleBatchEvents(raw: unknown): WhaleActionBatchStoredEvent[] {
    if (!Array.isArray(raw)) return [];
    const out: WhaleActionBatchStoredEvent[] = [];
    for (const row of raw) {
        if (typeof row !== 'string') continue;
        try {
            const j = JSON.parse(row) as WhaleActionBatchStoredEvent;
            if (
                j &&
                j.version === 1 &&
                j.discordPayload &&
                j.whaleMetricsJson &&
                typeof j.enqueuedAtMs === 'number'
            ) {
                out.push(j);
            }
        } catch {
            /* skip corrupt */
        }
    }
    return out;
}

export class WalletActionBatcher {
    constructor(
        private redis: IORedis,
        private batchQueue: Queue | null,
        private opts: WalletActionBatcherOptions,
    ) {}

    refreshOptions(opts: WalletActionBatcherOptions): void {
        this.opts = opts;
    }

    async enqueue(item: WhaleActionBatchStoredEvent, batchBase: string): Promise<'batched' | 'immediate_fallback'> {
        const o = this.opts;
        const lk = whaleBatchListKey(batchBase);
        const mk = whaleBatchMetaKey(batchBase);
        const ttlSec = Math.max(60, Math.ceil((Math.max(o.flushMs, 1000) * 2) / 1000));

        try {
            const serialized = JSON.stringify(item);
            const lenAfter = await this.redis.rpush(lk, serialized);
            await this.redis.hsetnx(mk, 'firstSeenAt', String(item.firstSeenAtCandidate));
            await this.redis.hset(mk, 'lastSeenAt', String(Date.now()));
            await this.redis.expire(lk, ttlSec);
            await this.redis.expire(mk, ttlSec);

            if (lenAfter === 1) {
                console.log(`[Batcher] new batch ${batchBase}`);
            }

            if (lenAfter >= o.maxItems) {
                console.log(`[Batcher] overflow flush (${o.maxItems}) for ${batchBase}`);
                void Promise.resolve(o.onFlushBatch(batchBase)).catch(err =>
                    console.error(`[Batcher] overflow onFlushBatch failed (${batchBase}):`, err),
                );
                return 'batched';
            }

            if (lenAfter === 1 && this.batchQueue) {
                try {
                    await this.batchQueue.add(
                        'wallet_action_batch_flush',
                        { batchBase },
                        {
                            jobId: batchFlushJobId(batchBase),
                            delay: o.flushMs,
                            removeOnComplete: { age: 7200 },
                            removeOnFail: { age: 86_400 },
                        },
                    );
                } catch (err) {
                    console.warn('[Batcher] schedule flush failed; flushing immediately.', err);
                    void Promise.resolve(o.onFlushBatch(batchBase)).catch(e2 =>
                        console.error(`[Batcher] schedule-fallback flush failed (${batchBase}):`, e2),
                    );
                    return 'batched';
                }
            }
            return 'batched';
        } catch (err) {
            console.warn('[Batcher] Redis push failed; caller should fall back to single dispatch.', err);
            return 'immediate_fallback';
        }
    }

    async drain(batchBase: string): Promise<string[]> {
        const lk = whaleBatchListKey(batchBase);
        const mk = whaleBatchMetaKey(batchBase);
        try {
            const raw = await this.redis.eval(DRAIN_EVENTS_LUA, 2, lk, mk);
            if (!Array.isArray(raw)) return [];
            return raw.filter((x): x is string => typeof x === 'string');
        } catch (err) {
            console.error(`[Batcher] drain failed for ${batchBase}:`, err);
            return [];
        }
    }

    static flushJobId(batchBase: string): string {
        return batchFlushJobId(batchBase);
    }
}
