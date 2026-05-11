import type Redis from 'ioredis';

const FS = '\x1f';
const HOT_SET = (chain: string) => `opportunity:hot_contracts:${chain.toLowerCase()}`;
const TRADE_Z = (chain: string, contract: string) =>
    `opportunity:trade:z:${chain.toLowerCase()}:${contract.toLowerCase()}`;
const SWEEP_Z = (chain: string, contract: string) =>
    `opportunity:sweep:z:${chain.toLowerCase()}:${contract.toLowerCase()}`;
const TRACKED_Z = (chain: string, contract: string) =>
    `opportunity:tracked:z:${chain.toLowerCase()}:${contract.toLowerCase()}`;
const FLOOR_Z = (chain: string, contract: string) =>
    `opportunity:floor_hist:z:${chain.toLowerCase()}:${contract.toLowerCase()}`;

const MAX_TRADE_AGE_MS = 2 * 60 * 60 * 1000;

export async function markOpportunityHotContract(r: Redis, chain: string, contract: string): Promise<void> {
    const ch = (chain || 'ethereum').toLowerCase();
    const c = (contract || '').toLowerCase();
    if (!c.startsWith('0x') || c.length !== 42) return;
    try {
        await r.sadd(HOT_SET(ch), c);
        await r.expire(HOT_SET(ch), 7200);
    } catch {
        /* best-effort */
    }
}

export async function isOpportunityHotContract(r: Redis, chain: string, contract: string): Promise<boolean> {
    try {
        const v = await r.sismember(HOT_SET((chain || 'ethereum').toLowerCase()), contract.toLowerCase());
        return v === 1;
    } catch {
        return false;
    }
}

export interface TradeIngestArgs {
    chain: string;
    contract: string;
    tsMs: number;
    buyer: string;
    seller: string;
    priceNative: number;
    txHash: string;
    eventId: string;
}

/**
 * Redis-backed sliding trade log per collection (multi-replica safe append + prune).
 */
export async function recordOpportunityTrade(r: Redis, args: TradeIngestArgs): Promise<void> {
    const chain = (args.chain || 'ethereum').toLowerCase();
    const contract = (args.contract || '').toLowerCase();
    if (!contract.startsWith('0x') || contract.length !== 42) return;
    const buyer = (args.buyer || '').toLowerCase();
    const seller = (args.seller || '').toLowerCase();
    if (!buyer || !seller) return;
    const ts = args.tsMs > 0 ? args.tsMs : Date.now();
    const member = `${String(args.eventId || '').trim()}${FS}${buyer}${FS}${seller}${FS}${args.priceNative}${FS}${(args.txHash || '').toLowerCase()}`;
    const zkey = TRADE_Z(chain, contract);
    const cutoff = ts - MAX_TRADE_AGE_MS;
    const pipe = r.multi();
    pipe.zadd(zkey, ts, member);
    pipe.zremrangebyscore(zkey, '-inf', cutoff);
    pipe.expire(zkey, Math.ceil(MAX_TRADE_AGE_MS / 1000) + 120);
    await pipe.exec();
}

export interface SweepIngestArgs {
    chain: string;
    contract: string;
    tsMs: number;
    eventId: string;
    itemCount: number;
    totalNative: number;
    uniqueBuyers?: number;
}

export async function recordOpportunitySweep(r: Redis, args: SweepIngestArgs): Promise<void> {
    const chain = (args.chain || 'ethereum').toLowerCase();
    const contract = (args.contract || '').toLowerCase();
    if (!contract.startsWith('0x') || contract.length !== 42) return;
    const ts = args.tsMs > 0 ? args.tsMs : Date.now();
    const member = `${args.eventId}${FS}${args.itemCount}${FS}${args.totalNative}${FS}${args.uniqueBuyers ?? 1}`;
    const zkey = SWEEP_Z(chain, contract);
    const cutoff = ts - MAX_TRADE_AGE_MS;
    const pipe = r.multi();
    pipe.zadd(zkey, ts, member);
    pipe.zremrangebyscore(zkey, '-inf', cutoff);
    pipe.expire(zkey, Math.ceil(MAX_TRADE_AGE_MS / 1000) + 120);
    await pipe.exec();
}

export async function recordOpportunityTrackedBuy(r: Redis, chain: string, contract: string, tsMs: number, key: string) {
    const ch = (chain || 'ethereum').toLowerCase();
    const c = (contract || '').toLowerCase();
    if (!c.startsWith('0x') || c.length !== 42) return;
    const ts = tsMs > 0 ? tsMs : Date.now();
    const zkey = TRACKED_Z(ch, c);
    const cutoff = ts - MAX_TRADE_AGE_MS;
    const pipe = r.multi();
    pipe.zadd(zkey, ts, key);
    pipe.zremrangebyscore(zkey, '-inf', cutoff);
    pipe.expire(zkey, Math.ceil(MAX_TRADE_AGE_MS / 1000) + 120);
    await pipe.exec();
}

export async function recordOpportunityFloorSample(r: Redis, chain: string, contract: string, tsMs: number, floorNative: number) {
    const ch = (chain || 'ethereum').toLowerCase();
    const c = (contract || '').toLowerCase();
    if (!c.startsWith('0x') || c.length !== 42) return;
    if (!(floorNative > 0)) return;
    const ts = tsMs > 0 ? tsMs : Date.now();
    const zkey = FLOOR_Z(ch, c);
    const member = `${ts}${FS}${floorNative}`;
    const cutoff = ts - MAX_TRADE_AGE_MS;
    const pipe = r.multi();
    pipe.zadd(zkey, ts, member);
    pipe.zremrangebyscore(zkey, '-inf', cutoff);
    pipe.expire(zkey, Math.ceil(MAX_TRADE_AGE_MS / 1000) + 120);
    await pipe.exec();
}

export function tradeZKey(chain: string, contract: string) {
    return TRADE_Z(chain, contract);
}
export function sweepZKey(chain: string, contract: string) {
    return SWEEP_Z(chain, contract);
}
export function trackedZKey(chain: string, contract: string) {
    return TRACKED_Z(chain, contract);
}
export function floorHistZKey(chain: string, contract: string) {
    return FLOOR_Z(chain, contract);
}
export function hotContractsSetKey(chain: string) {
    return HOT_SET(chain);
}
