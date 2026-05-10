import axios from 'axios';
import type IORedis from 'ioredis';
import { Contract } from 'ethers';
import type { RpcPool } from './RpcPool';
import type { NFTMetadata } from './NFTMetadata';

const LOG_PREFIX = '[NftNameResolver]';

export const NFT_NAME_RESOLVER_TOTAL_MS = 5000;
const REDIS_GET_MS = 400;
const OPENSEA_STEP_MS = 2600;
const ALCHEMY_STEP_MS = 2600;
const ONCHAIN_URI_CAP_MS = 3000;
const SUCCESS_TTL_SEC = 24 * 60 * 60;
const SYNTH_TTL_SEC = 5 * 60;
const DISPLAY_MAX = 200;

export type NftNameSource = 'cache' | 'opensea' | 'alchemy' | 'onchain' | 'synthetic';

export interface ResolvedNftName {
    name: string;
    source: NftNameSource;
}

export interface NftNameLookups {
    fetchNFTOpenSeaOnly(
        chain: 'ethereum',
        contract: string,
        tokenId: string,
    ): Promise<NFTMetadata | null>;
    fetchNFTAlchemyOnly(
        chain: 'ethereum',
        contract: string,
        tokenId: string,
    ): Promise<NFTMetadata | null>;
}

interface PersistedOk {
    name: string;
    source: Exclude<NftNameSource, 'cache' | 'synthetic'>;
}

interface PersistedSynth {
    name: string;
    source: 'synthetic';
}

function normalizeContract(contract: string): string | null {
    const c = (contract || '').trim().toLowerCase();
    return /^0x[a-fA-F0-9]{40}$/.test(c) ? c : null;
}

export function canonicalNftNameRedisKey(contractLc: string, tid: string): string {
    return `nft_name:${contractLc}:${tid}`;
}

function normalizeTokenId(tokenId: string): string | null {
    const t = (tokenId || '').trim();
    if (!t) return null;
    if (/^-?\d+$/.test(t)) {
        try {
            return BigInt(t).toString(10);
        } catch {
            return t;
        }
    }
    return t;
}

function synthKeyHash(collectionLabel: string, contractLc: string, tid: string): number {
    const s = `${collectionLabel.trim().toLowerCase()}\0${contractLc}\0${tid}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function syntheticRedisKey(contractLc: string, tid: string, collectionLabel: string): string {
    return `nft_name_synth:${contractLc}:${tid}:${synthKeyHash(collectionLabel, contractLc, tid)}`;
}

export function tokenUriToHttpsGateway(uriRaw: string): string | null {
    const t = uriRaw.trim();
    if (t.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${t.slice('ipfs://'.length)}`;
    if (t.startsWith('http://') || t.startsWith('https://')) return t;
    return null;
}

function erc1155Subst(uriRaw: string, tokenDec: string): string {
    if (!uriRaw.includes('{id}')) return uriRaw;
    let bn: bigint;
    try {
        bn = BigInt(tokenDec);
    } catch {
        return uriRaw.replace(/\{id\}/g, '0'.repeat(64));
    }
    return uriRaw.replace(/\{id\}/gi, bn.toString(16).padStart(64, '0'));
}

function decodeDataUri(uriRaw: string): unknown | null {
    const trimmed = uriRaw.trim();
    if (!trimmed.toLowerCase().startsWith('data:')) return null;
    const comma = trimmed.indexOf(',');
    if (comma <= 5) return null;
    const header = trimmed.slice(5, comma).toLowerCase();
    const payload = trimmed.slice(comma + 1);
    let body: string;
    if (header.includes(';base64')) {
        try {
            body = Buffer.from(payload, 'base64').toString('utf8');
        } catch {
            return null;
        }
    } else {
        try {
            body = decodeURIComponent(payload);
        } catch {
            body = payload;
        }
    }
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

function pickJsonName(obj: unknown): string | null {
    if (!obj || typeof obj !== 'object') return null;
    const name = (obj as { name?: unknown }).name;
    const meta = (obj as { metadata?: { name?: unknown } }).metadata?.name;
    for (const c of [name, meta]) {
        if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    }
    return null;
}

export function isPlaceholderNftName(name: string | null | undefined): boolean {
    const t = typeof name === 'string' ? name.trim() : '';
    if (!t) return true;
    return t.toLowerCase() === 'unknown';
}

function sanitizeName(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t || isPlaceholderNftName(t)) return null;
    return t.length > DISPLAY_MAX ? t.slice(0, DISPLAY_MAX) : t;
}

function syntheticLabel(collectionName: string | undefined | null, tid: string): string {
    const c = (collectionName || '').trim();
    return c ? `${c} #${tid}` : `Token #${tid}`;
}

async function raceCap<T>(ms: number, p: Promise<T>): Promise<T | null> {
    if (ms <= 0) return null;
    try {
        return (await Promise.race([
            p,
            new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
        ])) as T | null;
    } catch {
        return null;
    }
}

async function fetchNameFromTokenUri(uriRaw: string, tid: string, capMs: number): Promise<string | null> {
    const t = uriRaw.trim();
    if (!t) return null;

    if (t.toLowerCase().startsWith('data:')) {
        return sanitizeName(pickJsonName(decodeDataUri(t)) ?? undefined);
    }

    const sub = erc1155Subst(t, tid);
    const url = tokenUriToHttpsGateway(sub) ?? tokenUriToHttpsGateway(t);
    if (!url) return null;

    const budget = Math.max(300, Math.min(capMs, 2900));
    try {
        const res = await axios.get<unknown>(url, { timeout: budget, validateStatus: () => true });
        if (res.status >= 400) return null;
        let payload: unknown = res.data;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                return null;
            }
        }
        return sanitizeName(pickJsonName(payload) ?? undefined);
    } catch {
        return null;
    }
}

async function readOnChainName(rpc: RpcPool, contractLc: string, tid: string, capMs: number): Promise<string | null> {
    if (capMs <= 0) return null;
    let bn: bigint;
    try {
        bn = BigInt(tid);
    } catch {
        return null;
    }

    const prov = rpc.getHttpsProvider();
    const half = Math.max(400, Math.floor(capMs / 2));

    try {
        const c721 = new Contract(contractLc, ['function tokenURI(uint256 tokenId) view returns (string)'], prov);
        const u1 = await raceCap(half, c721.tokenURI(bn) as Promise<string>);
        if (typeof u1 === 'string' && u1.trim()) {
            const nm = await fetchNameFromTokenUri(u1, tid, Math.max(300, capMs - half));
            if (nm) {
                rpc.markHttpsSuccess(prov);
                return nm;
            }
        }
    } catch {
        /* ERC-721 miss */
    }

    const left = Math.max(400, capMs - half);

    try {
        const c1155 = new Contract(contractLc, ['function uri(uint256 id) view returns (string)'], prov);
        const u2 = await raceCap(left, c1155.uri(bn) as Promise<string>);
        if (typeof u2 === 'string' && u2.trim()) {
            const nm = await fetchNameFromTokenUri(u2, tid, left);
            if (nm) {
                rpc.markHttpsSuccess(prov);
                return nm;
            }
        }
    } catch {
        /* ERC-1155 miss */
    }
    return null;
}

export class NftNameResolver {
    private redis: IORedis | null;
    private lookups: NftNameLookups;
    private rpc: RpcPool | null;

    constructor(opts: {
        redis?: IORedis | null;
        nftMetadata: NftNameLookups;
        rpcPool?: RpcPool | null;
    }) {
        this.redis = opts.redis ?? null;
        this.lookups = opts.nftMetadata;
        this.rpc = opts.rpcPool ?? null;
    }

    public async resolveNftName(
        contract: string,
        tokenId: string,
        opts?: { collectionName?: string },
    ): Promise<ResolvedNftName> {
        const c = normalizeContract(contract);
        const tid = normalizeTokenId(tokenId);

        const fallbackSynth = (): ResolvedNftName => ({
            name: syntheticLabel(opts?.collectionName, tid ?? (tokenId.trim() || '?')),
            source: 'synthetic',
        });

        if (!c || !tid) return fallbackSynth();

        const deadline = Date.now() + NFT_NAME_RESOLVER_TOTAL_MS;
        const canonKey = canonicalNftNameRedisKey(c, tid);

        try {
            const rb = Math.min(REDIS_GET_MS, Math.max(0, deadline - Date.now()));
            if (this.redis && rb > 0) {
                const rawCanon = await raceCap(rb, this.redis.get(canonKey));
                if (rawCanon) {
                    try {
                        const hit = JSON.parse(rawCanon) as PersistedOk;
                        const nm = sanitizeName(hit?.name ?? undefined);
                        const src = hit?.source;
                        if (
                            nm &&
                            (src === 'opensea' || src === 'alchemy' || src === 'onchain')
                        ) {
                            console.info(`${LOG_PREFIX} cache canon contract=${c} token=${tid} src=${src}`);
                            return { name: nm, source: 'cache' };
                        }
                    } catch {
                        /* malformed */
                    }
                }

                const cn = opts?.collectionName ?? '';
                if (cn.trim()) {
                    const sk = syntheticRedisKey(c, tid, cn);
                    const synRaw = await raceCap(rb, this.redis.get(sk));
                    if (synRaw) {
                        try {
                            const syn = JSON.parse(synRaw) as PersistedSynth;
                            const nm = sanitizeName(syn?.name ?? undefined);
                            if (nm && syn?.source === 'synthetic') {
                                console.info(`${LOG_PREFIX} cache synth contract=${c} token=${tid}`);
                                return { name: nm, source: 'cache' };
                            }
                        } catch {
                            /* malformed */
                        }
                    }
                }
            }

            let left = deadline - Date.now();
            const osBudget = Math.min(OPENSEA_STEP_MS, Math.max(0, left));
            if (osBudget > 0) {
                const osMeta = await raceCap(
                    osBudget,
                    this.lookups.fetchNFTOpenSeaOnly('ethereum', c, tid),
                );
                const fromOs = sanitizeName(osMeta?.name ?? undefined);
                if (fromOs) {
                    await this.persistCanon(
                        canonKey,
                        { name: fromOs, source: 'opensea' },
                        SUCCESS_TTL_SEC,
                        deadline,
                    );
                    console.info(`${LOG_PREFIX} opensea contract=${c} token=${tid}`);
                    return { name: fromOs, source: 'opensea' };
                }
            }

            left = deadline - Date.now();
            const alBudget = Math.min(ALCHEMY_STEP_MS, Math.max(0, left));
            if (alBudget > 0) {
                const am = await raceCap(
                    alBudget,
                    this.lookups.fetchNFTAlchemyOnly('ethereum', c, tid),
                );
                const fromAl = sanitizeName(am?.name ?? undefined);
                if (fromAl) {
                    await this.persistCanon(
                        canonKey,
                        { name: fromAl, source: 'alchemy' },
                        SUCCESS_TTL_SEC,
                        deadline,
                    );
                    console.info(`${LOG_PREFIX} alchemy contract=${c} token=${tid}`);
                    return { name: fromAl, source: 'alchemy' };
                }
            }

            left = deadline - Date.now();
            const onBudget = Math.min(ONCHAIN_URI_CAP_MS, Math.max(0, left));
            if (onBudget > 0 && this.rpc && this.rpc.httpsUrls.length > 0) {
                try {
                    const onNm = await readOnChainName(this.rpc, c, tid, onBudget);
                    if (onNm) {
                        await this.persistCanon(
                            canonKey,
                            { name: onNm, source: 'onchain' },
                            SUCCESS_TTL_SEC,
                            deadline,
                        );
                        console.info(`${LOG_PREFIX} onchain contract=${c} token=${tid}`);
                        return { name: onNm, source: 'onchain' };
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`${LOG_PREFIX} on-chain uri failed ${c}:${tid}: ${msg}`);
                }
            }

            const syn = syntheticLabel(opts?.collectionName, tid);
            const coll = opts?.collectionName ?? '';
            if (this.redis && coll.trim()) {
                const sk = syntheticRedisKey(c, tid, coll);
                await this.persistSynth(sk, { name: syn, source: 'synthetic' }, SYNTH_TTL_SEC, deadline);
            }
            console.info(`${LOG_PREFIX} synthetic contract=${c} token=${tid}`);
            return { name: syn, source: 'synthetic' };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`${LOG_PREFIX} resolve error contract=${contract} token=${tokenId}: ${msg}`);
            return fallbackSynth();
        }
    }

    private async persistCanon(key: string, payload: PersistedOk, ttl: number, dl: number): Promise<void> {
        await this.setJson(key, payload, ttl, dl);
    }

    private async persistSynth(key: string, payload: PersistedSynth, ttl: number, dl: number): Promise<void> {
        await this.setJson(key, payload, ttl, dl);
    }

    private async setJson(key: string, payload: object, ttlSec: number, deadline: number): Promise<void> {
        if (!this.redis) return;
        const ms = Math.min(REDIS_GET_MS, Math.max(0, deadline - Date.now()));
        if (ms <= 0) return;
        await raceCap(ms, this.redis.set(key, JSON.stringify(payload), 'EX', ttlSec)).catch(() => {});
    }
}
