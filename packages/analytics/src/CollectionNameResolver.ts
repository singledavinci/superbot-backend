import type IORedis from 'ioredis';
import { Contract } from 'ethers';
import type { CollectionMetadata } from './NFTMetadata';
import type { RpcPool } from './RpcPool';

const LOG_PREFIX = '[CollectionNameResolver]';

/** Total wall budget for one resolve() call — avoids blocking dispatch. */
export const COLLECTION_RESOLVER_TOTAL_MS = 6_000;
const REDIS_GET_CAP_MS = 1_000;
const OPENSEA_STEP_MS = 3_000;
const ALCHEMY_STEP_MS = 3_000;
const ONCHAIN_STEP_MS = 2_000;
const SUCCESS_CACHE_TTL_SEC = 24 * 60 * 60;
const FALLBACK_CACHE_TTL_SEC = 5 * 60;
const DISPLAY_NAME_MAX = 200;

export type CollectionNameSource = 'opensea' | 'alchemy' | 'tracked' | 'onchain' | 'fallback';

export interface CollectionNameResolved {
    name: string;
    source: CollectionNameSource;
}

interface CachedPayload {
    name: string;
    source: CollectionNameSource;
}

export interface NftCollectionNameLookups {
    fetchCollectionOpenSeaMeta(
        contract: string,
        chain?: 'ethereum',
    ): Promise<CollectionMetadata | null>;
    fetchCollectionAlchemyMeta(
        contract: string,
        chain?: 'ethereum',
    ): Promise<CollectionMetadata | null>;
}

/** Formatted deterministic label when metadata is unavailable ("Collection 0xed5a…c544"). */
export function formatFallbackCollectionName(contract: string): string {
    const raw = typeof contract === 'string' ? contract.trim().toLowerCase() : '';
    if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
        return `Collection ${raw.slice(0, 6)}…${raw.slice(-4)}`;
    }
    if (raw) return `Collection ${raw.slice(0, 6)}…${raw.slice(-4)}`;
    return 'Collection —';
}

/**
 * Weak names we should overwrite / skip in favor of off-chain/on-chain lookups.
 * Includes raw or shortened 0x… addresses (but not `"Collection 0x…"` fallback labels —
 * those are readable and should not be discarded as placeholders).
 */
export function isPlaceholderCollectionName(name: string | null | undefined): boolean {
    const t = typeof name === 'string' ? name.trim() : '';
    if (!t) return true;
    if (t.toLowerCase() === 'unknown') return true;
    if (/^0x[a-fA-F0-9]{40}$/i.test(t)) return true;
    if (/^0x[a-fA-F0-9]{4,12}…[a-fA-F0-9]{4}$/u.test(t)) return true;
    if (/^0x[a-fA-F0-9]{4,12}\.{3}[a-fA-F0-9]{4}$/i.test(t)) return true;
    return false;
}

function cacheKey(contractLower: string): string {
    return `collection_name:${contractLower}`;
}

function sanitizeDisplayName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t || isPlaceholderCollectionName(t)) return null;
    return t.length > DISPLAY_NAME_MAX ? t.slice(0, DISPLAY_NAME_MAX) : t;
}

function normalizeContract(contract: string): string | null {
    const c = (contract || '').trim().toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(c)) return null;
    return c;
}

async function raceCap<T>(ms: number, p: Promise<T>): Promise<T | null> {
    if (ms <= 0) return null;
    try {
        return await Promise.race([
            p,
            new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
        ]);
    } catch {
        return null;
    }
}

const NAME_ABI = ['function name() view returns (string)'] as const;

export class CollectionNameResolver {
    private redis: IORedis | null;
    private nftMetadata: NftCollectionNameLookups;
    private rpcPool: RpcPool | null;

    constructor(opts: {
        redis?: IORedis | null;
        nftMetadata: NftCollectionNameLookups;
        rpcPool?: RpcPool | null;
    }) {
        this.redis = opts.redis ?? null;
        this.nftMetadata = opts.nftMetadata;
        this.rpcPool = opts.rpcPool ?? null;
    }

    /** Resolve a human-readable collection label — never throws; honors a 6s global budget. */
    public async resolve(
        contract: string,
        opts?: { trackedName?: string },
    ): Promise<CollectionNameResolved> {
        const c = normalizeContract(contract);
        if (!c) {
            return { name: formatFallbackCollectionName(contract), source: 'fallback' };
        }

        const deadline = Date.now() + COLLECTION_RESOLVER_TOTAL_MS;

        try {
            // 1) Redis cache
            const ck = cacheKey(c);
            const redisCap = Math.min(REDIS_GET_CAP_MS, Math.max(0, deadline - Date.now()));
            if (this.redis && redisCap > 0) {
                const rawCached = await raceCap<string | null>(
                    redisCap,
                    this.redis.get(ck) as Promise<string | null>,
                ).catch(() => null);
                if (rawCached) {
                    try {
                        const hit = JSON.parse(rawCached) as CachedPayload;
                        const nameHit = sanitizeDisplayName(hit?.name);
                        if (nameHit && hit?.source) {
                            console.info(
                                `${LOG_PREFIX} cache hit contract=${c} source=${hit.source}`,
                            );
                            return { name: nameHit, source: hit.source };
                        }
                    } catch {
                        /* ignore invalid cache */
                    }
                }
            }

            // 2) Tracked / DB name (guild-supplied resolution hint)
            const trackedCandidate = sanitizeDisplayName(opts?.trackedName ?? undefined);
            if (trackedCandidate) {
                console.info(`${LOG_PREFIX} tracked contract=${c}`);
                await this.redisCacheResult(ck, {
                    name: trackedCandidate,
                    source: 'tracked',
                    ttlSec: SUCCESS_CACHE_TTL_SEC,
                    deadline,
                });
                return { name: trackedCandidate, source: 'tracked' };
            }

            // 3) OpenSea (via NFT metadata client helpers)
            const osCap = Math.min(OPENSEA_STEP_MS, Math.max(0, deadline - Date.now()));
            if (osCap > 0) {
                const osMeta = await raceCap(
                    osCap,
                    this.nftMetadata.fetchCollectionOpenSeaMeta(c),
                ).catch(() => null);
                const osName = sanitizeDisplayName(osMeta?.name ?? undefined);
                if (osName) {
                    console.info(`${LOG_PREFIX} opensea contract=${c}`);
                    await this.redisCacheResult(ck, {
                        name: osName,
                        source: 'opensea',
                        ttlSec: SUCCESS_CACHE_TTL_SEC,
                        deadline,
                    });
                    return { name: osName, source: 'opensea' };
                }
            }

            // 4) Alchemy contract metadata only
            const acCap = Math.min(ALCHEMY_STEP_MS, Math.max(0, deadline - Date.now()));
            if (acCap > 0) {
                const acMeta = await raceCap(
                    acCap,
                    this.nftMetadata.fetchCollectionAlchemyMeta(c),
                ).catch(() => null);
                const acName = sanitizeDisplayName(acMeta?.name ?? undefined);
                if (acName) {
                    console.info(`${LOG_PREFIX} alchemy contract=${c}`);
                    await this.redisCacheResult(ck, {
                        name: acName,
                        source: 'alchemy',
                        ttlSec: SUCCESS_CACHE_TTL_SEC,
                        deadline,
                    });
                    return { name: acName, source: 'alchemy' };
                }
            }

            // 5) On-chain ERC-721/1155 `name()`
            const onCap = Math.min(ONCHAIN_STEP_MS, Math.max(0, deadline - Date.now()));
            if (onCap > 0 && this.rpcPool && this.rpcPool.httpsUrls.length > 0) {
                let provider;
                try {
                    provider = this.rpcPool.getHttpsProvider();
                    const onName = await raceCap(
                        onCap,
                        (async () => {
                            try {
                                const cc = new Contract(c, NAME_ABI, provider);
                                const s = await cc.name();
                                return typeof s === 'string' ? s : null;
                            } catch {
                                return null;
                            }
                        })(),
                    );
                    const pretty = sanitizeDisplayName(onName ?? undefined);
                    if (pretty) {
                        console.info(`${LOG_PREFIX} onchain contract=${c}`);
                        this.rpcPool.markHttpsSuccess(provider);
                        await this.redisCacheResult(ck, {
                            name: pretty,
                            source: 'onchain',
                            ttlSec: SUCCESS_CACHE_TTL_SEC,
                            deadline,
                        });
                        return { name: pretty, source: 'onchain' };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`${LOG_PREFIX} onchain failed contract=${c}: ${msg}`);
                }
            }

            const fb = formatFallbackCollectionName(c);
            console.info(`${LOG_PREFIX} fallback contract=${c}`);
            await this.redisCacheResult(ck, {
                name: fb,
                source: 'fallback',
                ttlSec: FALLBACK_CACHE_TTL_SEC,
                deadline,
            });
            return { name: fb, source: 'fallback' };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`${LOG_PREFIX} unexpected error contract=${c}: ${msg}`);
            return { name: formatFallbackCollectionName(c), source: 'fallback' };
        }
    }

    private async redisCacheResult(
        key: string,
        args: { name: string; source: CollectionNameSource; ttlSec: number; deadline: number },
    ): Promise<void> {
        if (!this.redis) return;
        const left = args.deadline - Date.now();
        if (left <= 0) return;
        const cap = Math.min(REDIS_GET_CAP_MS, left);
        if (cap <= 0) return;
        const payload: CachedPayload = { name: args.name, source: args.source };
        await raceCap(
            cap,
            this.redis.set(key, JSON.stringify(payload), 'EX', args.ttlSec) as Promise<'OK' | null>,
        ).catch(() => {
            /* best-effort */
        });
    }
}
