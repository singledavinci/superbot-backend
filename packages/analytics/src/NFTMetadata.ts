import axios from 'axios';
import type IORedis from 'ioredis';

export interface NFTTrait {
    trait_type: string;
    value: string;
}

export interface NFTMetadata {
    contract: string;
    tokenId: string;
    name: string | null;
    collectionName: string | null;
    collectionSlug: string | null;
    imageUrl: string | null;
    thumbnailUrl: string | null;
    traits: NFTTrait[] | null;
    rarityRank: number | null;
    openseaUrl: string | null;
}

export interface CollectionMetadata {
    contract: string;
    slug: string | null;
    name: string | null;
    imageUrl: string | null;
    bannerUrl: string | null;
    verified: boolean | null;
    totalSupply: number | null;
    floorPrice: number | null;
}

interface OpenSeaNftV2Response {
    nft?: {
        identifier?: string;
        collection?: string;
        contract?: string;
        token_standard?: string;
        name?: string | null;
        description?: string | null;
        image_url?: string | null;
        display_image_url?: string | null;
        display_animation_url?: string | null;
        opensea_url?: string | null;
        rarity?: { rank?: number | null } | null;
        traits?: Array<{ trait_type?: string; value?: string | number; display_type?: string | null }>;
    };
}

interface OpenSeaCollectionV2Response {
    collection?: string;
    name?: string;
    description?: string;
    image_url?: string;
    banner_image_url?: string;
    safelist_status?: string;
    is_verified?: boolean;
    total_supply?: number;
    contracts?: Array<{ address?: string; chain?: string }>;
    fees?: unknown;
    payment_tokens?: unknown;
}

interface OpenSeaContractV2Response {
    address?: string;
    chain?: string;
    collection?: string | { slug?: string };
}

interface AlchemyNftV3Response {
    name?: string | null;
    description?: string | null;
    tokenId?: string;
    tokenType?: string;
    image?: {
        cachedUrl?: string | null;
        thumbnailUrl?: string | null;
        pngUrl?: string | null;
        originalUrl?: string | null;
    };
    raw?: {
        metadata?: {
            name?: string | null;
            image?: string | null;
            attributes?: Array<{ trait_type?: string; value?: string | number }>;
        };
    };
    contract?: {
        address?: string;
        name?: string | null;
        symbol?: string | null;
        openSeaMetadata?: {
            collectionName?: string | null;
            collectionSlug?: string | null;
            imageUrl?: string | null;
            safelistRequestStatus?: string | null;
            floorPrice?: number | null;
        } | null;
    };
}

const POSITIVE_TTL_SEC = 60 * 60;        // 1 hour for hits
const NEGATIVE_TTL_SEC = 5 * 60;         // 5 minutes for misses
const COLLECTION_TTL_SEC = 24 * 60 * 60; // 24 hours for collection metadata
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * In-memory LRU as a fallback when Redis is unavailable.
 *
 * Bounded so a long-lived worker cannot leak memory by enriching tens of
 * thousands of distinct NFTs.
 */
class TinyLru<V> {
    private map = new Map<string, { v: V; exp: number }>();
    constructor(private cap = 2000) {}
    get(k: string): V | undefined {
        const entry = this.map.get(k);
        if (!entry) return undefined;
        if (entry.exp < Date.now()) {
            this.map.delete(k);
            return undefined;
        }
        this.map.delete(k);
        this.map.set(k, entry);
        return entry.v;
    }
    set(k: string, v: V, ttlSec: number) {
        if (this.map.size >= this.cap) {
            const first = this.map.keys().next().value;
            if (first !== undefined) this.map.delete(first);
        }
        this.map.set(k, { v, exp: Date.now() + ttlSec * 1000 });
    }
}

/**
 * Pulls per-NFT metadata (name, image, traits, rarity) from OpenSea v2 with an
 * Alchemy NFT API fallback for transient failures.
 *
 * Used by the alert pipeline to enrich Discord embeds — every external call is
 * wrapped in a bounded timeout and try/catch so an upstream outage degrades the
 * embed (no thumbnail/traits) but never blocks the alert.
 */
export class NFTMetadataClient {
    private openseaKey: string;
    private alchemyKey: string;
    private redis: IORedis | null;
    private memCache = new TinyLru<NFTMetadata | null>(2000);
    private collectionMemCache = new TinyLru<CollectionMetadata | null>(500);

    constructor(opts: { openseaKey?: string; alchemyKey?: string; redis?: IORedis | null } = {}) {
        this.openseaKey = opts.openseaKey ?? process.env.OPENSEA_API_KEY ?? '';
        this.alchemyKey = opts.alchemyKey ?? process.env.ALCHEMY_API_KEY ?? '';
        this.redis = opts.redis ?? null;
    }

    /**
     * Fetch metadata for a single NFT. Returns null if both providers fail or the NFT does not exist.
     * Negative results are cached briefly to absorb repeated lookups for the same missing token.
     */
    public async fetchNFT(
        chain: 'ethereum',
        contract: string,
        tokenId: string,
    ): Promise<NFTMetadata | null> {
        const key = `nft:${chain}:${contract.toLowerCase()}:${tokenId}`;

        const cached = await this.cacheGet<NFTMetadata | null>(key, this.memCache);
        if (cached !== undefined) return cached;

        let result: NFTMetadata | null = null;
        let isNegative = false;

        if (this.openseaKey) {
            const os = await this.fetchFromOpenSea(chain, contract, tokenId);
            if (os.kind === 'ok') {
                result = os.value;
            } else if (os.kind === 'not_found') {
                isNegative = true;
            }
        }

        if (!result && this.alchemyKey) {
            const al = await this.fetchFromAlchemy(chain, contract, tokenId);
            if (al) {
                result = al;
                isNegative = false;
            }
        }

        const ttl = result ? POSITIVE_TTL_SEC : isNegative ? NEGATIVE_TTL_SEC : 30;
        await this.cacheSet(key, result, ttl, this.memCache);
        return result;
    }

    /**
     * OpenSea v2 NFT path only (for deterministic resolver ordering). Bypasses Redis 
ft: cache
     * and skips Alchemy.
     */
    public async fetchNFTOpenSeaOnly(
        chain: 'ethereum',
        contract: string,
        tokenId: string,
    ): Promise<NFTMetadata | null> {
        if (!this.openseaKey) return null;
        const os = await this.fetchFromOpenSea(chain, contract, tokenId);
        return os.kind === 'ok' ? os.value : null;
    }

    /** Alchemy getNFTMetadata path only — bypasses Redis 
ft: cache. */
    public async fetchNFTAlchemyOnly(
        chain: 'ethereum',
        contract: string,
        tokenId: string,
    ): Promise<NFTMetadata | null> {
        if (!this.alchemyKey) return null;
        if (chain !== 'ethereum') return null;
        return this.fetchFromAlchemy(chain, contract, tokenId);
    }

    /**
     * Fetch collection-level metadata (name, image, verification status). Cached separately from
     * per-NFT entries because it changes orders of magnitude less often.
     */
    public async fetchCollection(
        contract: string,
        chain: 'ethereum' = 'ethereum',
    ): Promise<CollectionMetadata | null> {
        const key = `collection_meta:${chain}:${contract.toLowerCase()}`;

        const cached = await this.cacheGet<CollectionMetadata | null>(key, this.collectionMemCache);
        if (cached !== undefined) return cached;

        let result: CollectionMetadata | null = null;
        if (this.openseaKey) {
            result = await this.fetchCollectionFromOpenSea(chain, contract);
        }
        if (!result && this.alchemyKey) {
            result = await this.fetchCollectionFromAlchemy(chain, contract);
        }

        await this.cacheSet(
            key,
            result,
            result ? COLLECTION_TTL_SEC : NEGATIVE_TTL_SEC,
            this.collectionMemCache,
        );
        return result;
    }

    /**
     * OpenSea-only collection metadata (part of CollectionNameResolver fallback chain).
     * Does not read/write the NFTMetadata `collection_meta:` cache — resolver uses separate keys.
     */
    public async fetchCollectionOpenSeaMeta(
        contract: string,
        chain: 'ethereum' = 'ethereum',
    ): Promise<CollectionMetadata | null> {
        if (!this.openseaKey) return null;
        return this.fetchCollectionFromOpenSea(chain, contract);
    }

    /**
     * Alchemy-only `getContractMetadata` path (paired with fetchCollectionOpenSeaMeta for deterministic ordering).
     */
    public async fetchCollectionAlchemyMeta(
        contract: string,
        chain: 'ethereum' = 'ethereum',
    ): Promise<CollectionMetadata | null> {
        if (!this.alchemyKey) return null;
        return this.fetchCollectionFromAlchemy(chain, contract);
    }

    private async fetchFromOpenSea(
        chain: string,
        contract: string,
        tokenId: string,
    ): Promise<{ kind: 'ok'; value: NFTMetadata } | { kind: 'not_found' } | { kind: 'transient' }> {
        try {
            const res = await axios.get<OpenSeaNftV2Response>(
                `https://api.opensea.io/api/v2/chain/${chain}/contract/${contract.toLowerCase()}/nfts/${tokenId}`,
                {
                    headers: { 'X-API-KEY': this.openseaKey, accept: 'application/json' },
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );

            if (res.status === 404) return { kind: 'not_found' };
            if (res.status === 429 || res.status >= 500) return { kind: 'transient' };
            if (res.status >= 400) {
                console.warn(`[NFTMetadata] OpenSea ${res.status} for ${contract}:${tokenId}`);
                return { kind: 'transient' };
            }

            const nft = res.data?.nft;
            if (!nft) return { kind: 'not_found' };

            const slug = typeof nft.collection === 'string' ? nft.collection : null;
            const traits = Array.isArray(nft.traits)
                ? nft.traits
                      .filter(t => t && t.trait_type !== undefined && t.value !== undefined)
                      .map(t => ({
                          trait_type: String(t.trait_type),
                          value: String(t.value),
                      }))
                : null;

            const image = nft.display_image_url ?? nft.image_url ?? null;

            return {
                kind: 'ok',
                value: {
                    contract: contract.toLowerCase(),
                    tokenId,
                    name: nft.name ?? null,
                    collectionName: slug, // slug-only; resolveCollection callers can upgrade
                    collectionSlug: slug,
                    imageUrl: image,
                    thumbnailUrl: image,
                    traits: traits && traits.length > 0 ? traits : null,
                    rarityRank: nft.rarity?.rank ?? null,
                    openseaUrl:
                        nft.opensea_url ??
                        `https://opensea.io/assets/${chain}/${contract.toLowerCase()}/${tokenId}`,
                },
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[NFTMetadata] OpenSea fetch failed for ${contract}:${tokenId}: ${message}`);
            return { kind: 'transient' };
        }
    }

    private async fetchFromAlchemy(
        chain: string,
        contract: string,
        tokenId: string,
    ): Promise<NFTMetadata | null> {
        if (chain !== 'ethereum') return null;
        try {
            const res = await axios.get<AlchemyNftV3Response>(
                `https://eth-mainnet.g.alchemy.com/nft/v3/${this.alchemyKey}/getNFTMetadata`,
                {
                    params: {
                        contractAddress: contract.toLowerCase(),
                        tokenId,
                        refreshCache: false,
                    },
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );

            if (res.status >= 400 || !res.data) {
                if (res.status !== 404) {
                    console.warn(`[NFTMetadata] Alchemy ${res.status} for ${contract}:${tokenId}`);
                }
                return null;
            }

            const data = res.data;
            const rawAttrs = data.raw?.metadata?.attributes;
            const traits = Array.isArray(rawAttrs)
                ? rawAttrs
                      .filter(a => a && a.trait_type !== undefined && a.value !== undefined)
                      .map(a => ({
                          trait_type: String(a.trait_type),
                          value: String(a.value),
                      }))
                : null;

            const collectionName =
                data.contract?.openSeaMetadata?.collectionName ?? data.contract?.name ?? null;
            const slug = data.contract?.openSeaMetadata?.collectionSlug ?? null;
            const image =
                data.image?.cachedUrl ??
                data.image?.pngUrl ??
                data.image?.originalUrl ??
                data.raw?.metadata?.image ??
                null;
            const thumbnail = data.image?.thumbnailUrl ?? image;

            return {
                contract: contract.toLowerCase(),
                tokenId,
                name: data.name ?? data.raw?.metadata?.name ?? null,
                collectionName,
                collectionSlug: slug,
                imageUrl: image,
                thumbnailUrl: thumbnail,
                traits: traits && traits.length > 0 ? traits : null,
                rarityRank: null, // Alchemy v3 does not return a free-tier rarity rank.
                openseaUrl: `https://opensea.io/assets/ethereum/${contract.toLowerCase()}/${tokenId}`,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
                `[NFTMetadata] Alchemy fetch failed for ${contract}:${tokenId}: ${message}`,
            );
            return null;
        }
    }

    private async fetchCollectionFromOpenSea(
        chain: string,
        contract: string,
    ): Promise<CollectionMetadata | null> {
        try {
            const slugRes = await axios.get<OpenSeaContractV2Response>(
                `https://api.opensea.io/api/v2/chain/${chain}/contract/${contract.toLowerCase()}`,
                {
                    headers: { 'X-API-KEY': this.openseaKey, accept: 'application/json' },
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );

            if (slugRes.status >= 400) return null;

            const rawSlug = slugRes.data?.collection;
            const slug =
                typeof rawSlug === 'string'
                    ? rawSlug
                    : (rawSlug && typeof rawSlug === 'object' && rawSlug.slug) || null;

            if (!slug) return null;

            const colRes = await axios.get<OpenSeaCollectionV2Response>(
                `https://api.opensea.io/api/v2/collections/${slug}`,
                {
                    headers: { 'X-API-KEY': this.openseaKey, accept: 'application/json' },
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );

            if (colRes.status >= 400 || !colRes.data) return null;
            const c = colRes.data;
            return {
                contract: contract.toLowerCase(),
                slug,
                name: c.name ?? null,
                imageUrl: c.image_url ?? null,
                bannerUrl: c.banner_image_url ?? null,
                verified:
                    typeof c.is_verified === 'boolean'
                        ? c.is_verified
                        : c.safelist_status === 'verified',
                totalSupply: typeof c.total_supply === 'number' ? c.total_supply : null,
                floorPrice: null,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[NFTMetadata] OpenSea collection fetch failed for ${contract}: ${message}`);
            return null;
        }
    }

    private async fetchCollectionFromAlchemy(
        _chain: string,
        contract: string,
    ): Promise<CollectionMetadata | null> {
        try {
            const res = await axios.get<{
                name?: string | null;
                symbol?: string | null;
                totalSupply?: string | null;
                openSeaMetadata?: {
                    collectionName?: string | null;
                    collectionSlug?: string | null;
                    imageUrl?: string | null;
                    safelistRequestStatus?: string | null;
                    floorPrice?: number | null;
                } | null;
            }>(
                `https://eth-mainnet.g.alchemy.com/nft/v3/${this.alchemyKey}/getContractMetadata`,
                {
                    params: { contractAddress: contract.toLowerCase() },
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );

            if (res.status >= 400 || !res.data) return null;
            const d = res.data;
            const total = d.totalSupply ? Number(d.totalSupply) : null;
            const slug = d.openSeaMetadata?.collectionSlug ?? null;
            return {
                contract: contract.toLowerCase(),
                slug,
                name: d.openSeaMetadata?.collectionName ?? d.name ?? null,
                imageUrl: d.openSeaMetadata?.imageUrl ?? null,
                bannerUrl: null,
                verified: d.openSeaMetadata?.safelistRequestStatus === 'verified',
                totalSupply: total !== null && !Number.isNaN(total) ? total : null,
                floorPrice:
                    typeof d.openSeaMetadata?.floorPrice === 'number'
                        ? d.openSeaMetadata.floorPrice
                        : null,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[NFTMetadata] Alchemy collection fetch failed for ${contract}: ${message}`);
            return null;
        }
    }

    private async cacheGet<T>(key: string, mem: TinyLru<T>): Promise<T | undefined> {
        const memHit = mem.get(key);
        if (memHit !== undefined) return memHit;
        if (!this.redis) return undefined;
        try {
            const raw = await this.redis.get(key);
            if (raw === null) return undefined;
            return JSON.parse(raw) as T;
        } catch {
            return undefined;
        }
    }

    private async cacheSet<T>(key: string, value: T, ttlSec: number, mem: TinyLru<T>): Promise<void> {
        mem.set(key, value, ttlSec);
        if (!this.redis) return;
        try {
            await this.redis.set(key, JSON.stringify(value), 'EX', ttlSec);
        } catch {
            // Cache is best-effort.
        }
    }
}
