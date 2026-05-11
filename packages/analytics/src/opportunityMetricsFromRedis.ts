import type Redis from 'ioredis';
import { parseFloorZMembers, parseTradeZMembers } from './opportunityScoring';
import {
    floorHistZKey,
    sweepZKey,
    trackedZKey,
    tradeZKey,
} from './OpportunityWindowStore';

export interface ListingSnapContext {
    listingDelta15m: number | null;
}

export async function loadOpportunityMetricsFromRedis(
    r: Redis,
    chain: string,
    contract: string,
    nowMs: number,
    listing: ListingSnapContext,
): Promise<import('./opportunityScoring').OpportunityMetricsInput> {
    const ch = (chain || 'ethereum').toLowerCase();
    const c = (contract || '').toLowerCase();

    const flat = await r.zrange(tradeZKey(ch, c), 0, -1, 'WITHSCORES');
    const trades = parseTradeZMembers(flat as string[]);

    const lo15 = nowMs - 15 * 60 * 1000;
    const sweepFlat = await r.zrangebyscore(sweepZKey(ch, c), lo15, nowMs);
    let sweepEvents15m = 0;
    let sweptItems15m = 0;
    let sweepNative15m = 0;
    const sweepBuyers = new Set<string>();
    for (const row of sweepFlat) {
        const p = String(row).split('\x1f');
        if (p.length < 3) continue;
        sweepEvents15m += 1;
        sweptItems15m += Number(p[1]) || 0;
        sweepNative15m += Number(p[2]) || 0;
        sweepBuyers.add('sweep');
    }
    const uniqueSweepBuyers15m = sweepBuyers.size;

    const trackedFlat = await r.zrangebyscore(trackedZKey(ch, c), lo15, nowMs);
    const trackedWalletBuys15m = trackedFlat.length;

    let floorNow: number | null = null;
    try {
        const raw = await r.get(`floor:${ch}:${c}`);
        if (raw) {
            const j = JSON.parse(raw) as { priceNative?: number };
            if (typeof j.priceNative === 'number' && j.priceNative > 0) floorNow = j.priceNative;
        }
    } catch {
        floorNow = null;
    }

    const floorRows = await r.zrange(floorHistZKey(ch, c), 0, -1);
    const floorSamples = parseFloorZMembers(floorRows as string[]);

    const a15 = trades.filter(t => t.tsMs >= lo15 && t.tsMs <= nowMs);
    const buyers = new Set(a15.map(t => t.buyer));
    const thinLiquidity = a15.length >= 4 && buyers.size <= 1;

    const d30 =
        floorNow && floorSamples.length
            ? (() => {
                  const target = nowMs - 30 * 60 * 1000;
                  const past = floorSamples.filter(s => s.tsMs <= target).sort((a, b) => b.tsMs - a.tsMs)[0];
                  if (!past?.priceNative) return 0;
                  return ((floorNow - past.priceNative) / past.priceNative) * 100;
              })()
            : 0;

    const listingSurgeDuringFloorRise =
        Boolean(listing.listingDelta15m !== null && listing.listingDelta15m > 3 && d30 > 0.5);

    const pairCounts = new Map<string, number>();
    for (const t of a15) {
        const pk = `${t.buyer}\x1f${t.seller}`;
        pairCounts.set(pk, (pairCounts.get(pk) ?? 0) + 1);
    }
    let heavyWashPairs = 0;
    for (const n of pairCounts.values()) {
        if (n >= 3) heavyWashPairs += 1;
    }

    const dataMissing = trades.length === 0 && floorSamples.length === 0 && !floorNow;

    return {
        nowMs,
        trades,
        sweepEvents15m,
        sweptItems15m,
        sweepNative15m,
        uniqueSweepBuyers15m,
        trackedWalletBuys15m,
        floorNow,
        floorSamples,
        listingDelta15m: listing.listingDelta15m,
        listingSurgeDuringFloorRise: listingSurgeDuringFloorRise,
        heavyWashPairs,
        thinLiquidity,
        dataMissing,
    };
}
