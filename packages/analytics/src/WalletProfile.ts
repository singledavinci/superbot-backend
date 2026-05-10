import axios from 'axios';
import { ethers, Network } from 'ethers';
import type IORedis from 'ioredis';

export interface WalletProfile {
    address: string;
    /** Reverse-resolved ENS name (e.g. "vitalik.eth") or null if none. */
    ens: string | null;
    /** OpenSea profile username if the wallet has an OpenSea account. */
    openseaUsername: string | null;
    /** Deterministic OpenSea profile URL. */
    openseaUrl: string;
    /** Deterministic Etherscan address URL. */
    etherscanUrl: string;
    /** Approx. count of NFTs held (Alchemy `getNFTsForOwner`); null if not fetched. */
    holdingsCount: number | null;
    /** Top 3 collections held by item count, when available. */
    topCollectionsByCount: { name: string; count: number }[] | null;
}

interface OpenSeaAccountResponse {
    address?: string;
    username?: string | null;
    profile_image_url?: string | null;
    user?: { username?: string | null } | null;
}

interface AlchemyOwnerNftsResponse {
    ownedNfts?: Array<{
        contract?: {
            address?: string;
            name?: string | null;
            openSeaMetadata?: { collectionName?: string | null } | null;
        };
        balance?: string;
    }>;
    totalCount?: number;
    pageKey?: string | null;
}

const PROFILE_TTL_SEC = 60 * 60;          // 1 hour
const NEGATIVE_TTL_SEC = 5 * 60;          // 5 minutes for outright failures
const REQUEST_TIMEOUT_MS = 4_000;
/**
 * ENS reverse-resolution does several sequential RPC calls (registry ->
 * resolver -> name -> forward-confirm), so 4s isn't enough on a cold provider.
 * Stay below the worker's 6s outer ceiling to leave room for axios / JSON.
 */
const ENS_TIMEOUT_MS = 5_500;

class TinyLru<V> {
    private map = new Map<string, { v: V; exp: number }>();
    constructor(private cap = 1000) {}
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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
    return new Promise<T | null>(resolve => {
        const t = setTimeout(() => {
            console.warn(`[WalletProfile] ${label} timed out after ${ms}ms`);
            resolve(null);
        }, ms);
        p.then(
            v => {
                clearTimeout(t);
                resolve(v);
            },
            err => {
                clearTimeout(t);
                const message = err instanceof Error ? err.message : String(err);
                console.warn(`[WalletProfile] ${label} failed: ${message}`);
                resolve(null);
            },
        );
    });
}

/**
 * Enriches an EVM address with display-friendly metadata (ENS, OpenSea profile,
 * holdings) for inclusion in Discord alert embeds.
 *
 * `fetchProfile` always returns a `WalletProfile` — even if every external
 * lookup fails the deterministic Etherscan/OpenSea URLs are populated, so the
 * Discord embed can still link out.
 */
export class WalletProfileClient {
    private alchemyKey: string;
    private openseaKey: string;
    private provider: ethers.JsonRpcProvider | null;
    private redis: IORedis | null;
    private memCache = new TinyLru<WalletProfile>(2000);

    constructor(opts: {
        alchemyKey?: string;
        openseaKey?: string;
        redis?: IORedis | null;
        provider?: ethers.JsonRpcProvider | null;
    } = {}) {
        this.alchemyKey = opts.alchemyKey ?? process.env.ALCHEMY_API_KEY ?? '';
        this.openseaKey = opts.openseaKey ?? process.env.OPENSEA_API_KEY ?? '';
        this.redis = opts.redis ?? null;

        if (opts.provider) {
            this.provider = opts.provider;
        } else if (this.alchemyKey) {
            // Pin the network so ethers skips its initial `eth_chainId` round
            // trip on every fresh provider — that handshake adds ~600ms to the
            // first lookupAddress call.
            this.provider = new ethers.JsonRpcProvider(
                `https://eth-mainnet.g.alchemy.com/v2/${this.alchemyKey}`,
                Network.from('mainnet'),
                { staticNetwork: true },
            );
        } else {
            this.provider = null;
        }
    }

    /**
     * Always returns a profile. Individual fields fall back to null if the
     * underlying provider call fails or times out — never throws.
     */
    public async fetchProfile(address: string): Promise<WalletProfile> {
        const addr = address.toLowerCase();
        const baseline: WalletProfile = {
            address: addr,
            ens: null,
            openseaUsername: null,
            openseaUrl: `https://opensea.io/${addr}`,
            etherscanUrl: `https://etherscan.io/address/${addr}`,
            holdingsCount: null,
            topCollectionsByCount: null,
        };

        if (!ethers.isAddress(addr) || addr === '0x0000000000000000000000000000000000000000') {
            return baseline;
        }

        const key = `wallet_profile:${addr}`;
        const memHit = this.memCache.get(key);
        if (memHit) return memHit;
        if (this.redis) {
            try {
                const raw = await this.redis.get(key);
                if (raw) {
                    const parsed = JSON.parse(raw) as WalletProfile;
                    this.memCache.set(key, parsed, PROFILE_TTL_SEC);
                    return parsed;
                }
            } catch {
                // Cache miss falls through.
            }
        }

        const [ens, opensea, holdings] = await Promise.all([
            this.lookupEns(addr),
            this.lookupOpenSeaProfile(addr),
            this.lookupAlchemyHoldings(addr),
        ]);

        const profile: WalletProfile = {
            ...baseline,
            ens,
            openseaUsername: opensea,
            holdingsCount: holdings.count,
            topCollectionsByCount: holdings.topCollections,
        };

        // Always cache the merged profile, even when partial. Use the negative
        // TTL when literally every enrichment failed, to retry sooner.
        const ttl =
            ens || opensea || holdings.count !== null ? PROFILE_TTL_SEC : NEGATIVE_TTL_SEC;
        this.memCache.set(key, profile, ttl);
        if (this.redis) {
            try {
                await this.redis.set(key, JSON.stringify(profile), 'EX', ttl);
            } catch {
                // Best effort.
            }
        }
        return profile;
    }

    private async lookupEns(address: string): Promise<string | null> {
        if (!this.provider) return null;
        return withTimeout(this.provider.lookupAddress(address), ENS_TIMEOUT_MS, `ENS ${address}`);
    }

    private async lookupOpenSeaProfile(address: string): Promise<string | null> {
        if (!this.openseaKey) return null;
        const fetch = async () => {
            const res = await axios.get<OpenSeaAccountResponse>(
                `https://api.opensea.io/api/v2/accounts/${address}`,
                {
                    headers: { 'X-API-KEY': this.openseaKey, accept: 'application/json' },
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );
            if (res.status >= 400) return null;
            return res.data?.username || res.data?.user?.username || null;
        };
        return withTimeout(fetch(), REQUEST_TIMEOUT_MS + 500, `OpenSea profile ${address}`);
    }

    private async lookupAlchemyHoldings(
        address: string,
    ): Promise<{ count: number | null; topCollections: { name: string; count: number }[] | null }> {
        if (!this.alchemyKey) return { count: null, topCollections: null };
        const fetch = async () => {
            const res = await axios.get<AlchemyOwnerNftsResponse>(
                `https://eth-mainnet.g.alchemy.com/nft/v3/${this.alchemyKey}/getNFTsForOwner`,
                {
                    params: {
                        owner: address,
                        withMetadata: true,
                        pageSize: 100,
                    },
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );
            if (res.status >= 400 || !res.data) return null;

            const totalCount =
                typeof res.data.totalCount === 'number' ? res.data.totalCount : null;
            const counts = new Map<string, { name: string; count: number }>();
            for (const nft of res.data.ownedNfts ?? []) {
                const name =
                    nft.contract?.openSeaMetadata?.collectionName ||
                    nft.contract?.name ||
                    nft.contract?.address ||
                    null;
                if (!name) continue;
                const existing = counts.get(name);
                if (existing) {
                    existing.count += 1;
                } else {
                    counts.set(name, { name, count: 1 });
                }
            }
            const top = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 3);
            return { totalCount, top };
        };

        const result = await withTimeout(fetch(), REQUEST_TIMEOUT_MS + 500, `Alchemy holdings ${address}`);
        if (!result) return { count: null, topCollections: null };
        return {
            count: result.totalCount,
            topCollections: result.top.length > 0 ? result.top : null,
        };
    }
}

/** Truncate an address for display: 0x1234…abcd. */
export function shortenAddress(addr: string, prefix = 6, suffix = 4): string {
    if (!addr) return '';
    if (addr.length <= prefix + suffix) return addr;
    return `${addr.slice(0, prefix)}…${addr.slice(-suffix)}`;
}

/** Display label preferring ENS over short address. */
export function walletDisplay(profile: Pick<WalletProfile, 'address' | 'ens'>): string {
    return profile.ens || shortenAddress(profile.address);
}
