/**
 * Deterministic scoring + gating for Collection Opportunity Monitor.
 * No I/O — pure functions for unit tests and server-side evaluation.
 */

const FS = '\x1f';

export type OpportunitySignalLevel = 'strong' | 'developing' | 'early';

export interface OpportunityScoreEnv {
    volumeSpikeMultiplier: number;
    tradeSpikeMultiplier: number;
    minUniqueBuyers: number;
    minTrades15m: number;
    minVolumeNative15m: number;
    requireTwoSignals: boolean;
    suspiciousActivityPenalty: boolean;
    scoreThreshold: number;
    strongScoreThreshold: number;
}

export function defaultOpportunityScoreEnv(): OpportunityScoreEnv {
    return {
        volumeSpikeMultiplier: Number(process.env.OPPORTUNITY_VOLUME_SPIKE_MULTIPLIER) || 3,
        tradeSpikeMultiplier: Number(process.env.OPPORTUNITY_TRADE_SPIKE_MULTIPLIER) || 2.5,
        minUniqueBuyers: Number(process.env.OPPORTUNITY_MIN_UNIQUE_BUYERS) || 4,
        minTrades15m: Number(process.env.OPPORTUNITY_MIN_TRADES_15M) || 5,
        minVolumeNative15m: Number(process.env.OPPORTUNITY_MIN_VOLUME_NATIVE_15M) || 1,
        requireTwoSignals: process.env.OPPORTUNITY_REQUIRE_TWO_SIGNALS !== 'false',
        suspiciousActivityPenalty: process.env.OPPORTUNITY_SUSPICIOUS_ACTIVITY_PENALTY !== 'false',
        scoreThreshold: Number(process.env.OPPORTUNITY_SCORE_THRESHOLD) || 65,
        strongScoreThreshold: Number(process.env.OPPORTUNITY_STRONG_SCORE_THRESHOLD) || 80,
    };
}

export interface TradeRow {
    tsMs: number;
    buyer: string;
    seller: string;
    priceNative: number;
    txHash: string;
}

export interface OpportunityMetricsInput {
    nowMs: number;
    trades: TradeRow[];
    /** Distinct sweep events in 15m */
    sweepEvents15m: number;
    sweptItems15m: number;
    sweepNative15m: number;
    uniqueSweepBuyers15m: number;
    trackedWalletBuys15m: number;
    floorNow: number | null;
    floorSamples: Array<{ tsMs: number; priceNative: number }>;
    /** Positive = listings increased (pressure up) */
    listingDelta15m: number | null;
    /** Whether listing count rose while floor also rose (penalty). */
    listingSurgeDuringFloorRise: boolean;
    /** Repeated buyer/seller pairs beyond casual threshold */
    heavyWashPairs: number;
    /** Volume in window with <=1 unique buyer */
    thinLiquidity: boolean;
    dataMissing: boolean;
}

export interface ScoredOpportunity {
    score: number;
    /** After clamp 0–100 */
    scoreClamped: number;
    confidence: 'high' | 'medium' | 'low' | 'insufficient';
    riskLabel:
        | 'Low observable risk'
        | 'Medium risk'
        | 'High risk'
        | 'Suspicious activity'
        | 'Insufficient verified data';
    signalLabel: string;
    signalLevel: OpportunitySignalLevel;
    suspiciousOverride: 'none' | 'suspicious_momentum' | 'high_risk_pump' | 'insufficient_data';
    /** Individual signal booleans for two-signal gate */
    gates: {
        volumeSpike: boolean;
        tradeSpike: boolean;
        sweepActivity: boolean;
        uniqueBuyerIncrease: boolean;
        trackedCluster: boolean;
        floorUpWithTrades: boolean;
        listingsFlatOrDown: boolean;
    };
    /** Count of gates.* that are true among the seven used for spec */
    signalCount: number;
    meetsMinActivity: boolean;
    passesTwoSignalRule: boolean;
    passesFloorNotAloneRule: boolean;
    shouldAlert: boolean;
    /** Sub-scores for transparency */
    parts: {
        volume: number;
        trades: number;
        sweep: number;
        uniqueBuyers: number;
        tracked: number;
        floor: number;
        listing: number;
        lowSuspicious: number;
        penalties: number;
    };
}

export function tradesInRange(trades: TradeRow[], nowMs: number, ms: number): TradeRow[] {
    const lo = nowMs - ms;
    return trades.filter(t => t.tsMs >= lo && t.tsMs <= nowMs);
}

function aggregateWindow(rows: TradeRow[]) {
    let vol = 0;
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    const pairCounts = new Map<string, number>();
    for (const t of rows) {
        vol += t.priceNative > 0 ? t.priceNative : 0;
        if (t.buyer) buyers.add(t.buyer);
        if (t.seller) sellers.add(t.seller);
        const pk = `${t.buyer}\x1f${t.seller}`;
        pairCounts.set(pk, (pairCounts.get(pk) ?? 0) + 1);
    }
    let heavyPairs = 0;
    for (const n of pairCounts.values()) {
        if (n >= 3) heavyPairs += 1;
    }
    return {
        trades: rows.length,
        volume: vol,
        uniqueBuyers: buyers.size,
        uniqueSellers: sellers.size,
        heavyPairs,
    };
}

function floorDeltaPct(samples: Array<{ tsMs: number; priceNative: number }>, nowMs: number, lookbackMs: number, floorNow: number | null): number | null {
    if (!(typeof floorNow === 'number') || floorNow <= 0) return null;
    const target = nowMs - lookbackMs;
    const past = samples.filter(s => s.tsMs <= target).sort((a, b) => b.tsMs - a.tsMs)[0];
    if (!past || !(past.priceNative > 0)) return null;
    return ((floorNow - past.priceNative) / past.priceNative) * 100;
}

function momentumConsistency(d15: number | null, d30: number | null, d60: number | null): 'rising' | 'fading' | 'unstable' {
    const vals = [d15, d30, d60].filter((x): x is number => x !== null && !Number.isNaN(x));
    if (vals.length < 2) return 'unstable';
    const pos = vals.filter(v => v > 0.1).length;
    const neg = vals.filter(v => v < -0.1).length;
    if (pos >= 2 && neg === 0) return 'rising';
    if (neg >= 2 && pos === 0) return 'fading';
    return 'unstable';
}

/**
 * Confidence per data completeness + number of firing contextual signals.
 */
export function opportunityConfidence(
    dataMissing: boolean,
    signalCount: number,
    limitationsCount: number,
): ScoredOpportunity['confidence'] {
    if (dataMissing || limitationsCount >= 3) return 'insufficient';
    if (limitationsCount >= 1 || signalCount < 2) return 'medium';
    if (signalCount >= 4) return 'high';
    return 'medium';
}

export function scoreOpportunity(m: OpportunityMetricsInput, env: OpportunityScoreEnv = defaultOpportunityScoreEnv()): ScoredOpportunity {
    const { nowMs, trades } = m;
    const t5m = tradesInRange(trades, nowMs, 5 * 60 * 1000);
    const t15 = tradesInRange(trades, nowMs, 15 * 60 * 1000);
    const t30 = tradesInRange(trades, nowMs, 30 * 60 * 1000);
    const t60 = tradesInRange(trades, nowMs, 60 * 60 * 1000);
    const t120 = tradesInRange(trades, nowMs, 120 * 60 * 1000);

    const a15 = aggregateWindow(t15);
    const a30 = aggregateWindow(t30);
    const a60 = aggregateWindow(t60);
    const a120 = aggregateWindow(t120);

    const baselineWindowMs = 120 * 60 * 1000;
    const baseline15Slots = Math.max(1, baselineWindowMs / (15 * 60 * 1000) - 1);
    const volBaseline =
        a120.volume > 0 ? Math.max(a120.volume / baseline15Slots, 1e-9) : 0;
    const tradeBaseline =
        a120.trades > 0 ? Math.max(a120.trades / baseline15Slots, 1e-9) : 0;

    const volumeSpike =
        volBaseline > 0 ? a15.volume >= volBaseline * env.volumeSpikeMultiplier : a15.volume >= env.minVolumeNative15m * env.volumeSpikeMultiplier;
    const tradeSpike =
        tradeBaseline > 0
            ? a15.trades >= tradeBaseline * env.tradeSpikeMultiplier
            : a15.trades >= Math.max(env.minTrades15m, 3);

    const sweepActivity = m.sweepEvents15m >= 1 || m.sweptItems15m >= 3 || m.sweepNative15m >= 0.3;

    const buyerGrowth =
        a30.uniqueBuyers > 0 ? a15.uniqueBuyers >= Math.max(2, Math.ceil(a30.uniqueBuyers * 0.35) + 1) : a15.uniqueBuyers >= env.minUniqueBuyers;

    const uniqueBuyerIncrease = buyerGrowth && a15.uniqueBuyers >= 2;

    const trackedCluster = m.trackedWalletBuys15m >= 2;

    const tradesSupportFloor = t15.length >= Math.min(env.minTrades15m, 3) && a15.volume >= env.minVolumeNative15m * 0.5;
    const d10 = floorDeltaPct(m.floorSamples, nowMs, 10 * 60 * 1000, m.floorNow);
    const d30f = floorDeltaPct(m.floorSamples, nowMs, 30 * 60 * 1000, m.floorNow);
    const d60f = floorDeltaPct(m.floorSamples, nowMs, 60 * 60 * 1000, m.floorNow);
    const floorUpWithTrades =
        typeof d30f === 'number' && d30f > 0.25 && tradesSupportFloor && (t5m.length >= 1 || t15.length >= 2);

    const listingsFlatOrDown =
        m.listingDelta15m === null ? false : m.listingDelta15m <= 0 || (m.listingDelta15m > 0 && m.listingDelta15m < 2);

    const gates = {
        volumeSpike,
        tradeSpike,
        sweepActivity,
        uniqueBuyerIncrease,
        trackedCluster,
        floorUpWithTrades,
        listingsFlatOrDown,
    };

    const signalCount = Object.values(gates).filter(Boolean).length;

    let parts = {
        volume: 0,
        trades: 0,
        sweep: 0,
        uniqueBuyers: 0,
        tracked: 0,
        floor: 0,
        listing: 0,
        lowSuspicious: 0,
        penalties: 0,
    };

    // Positive components (caps from spec)
    if (volumeSpike) parts.volume = Math.min(20, 12 + Math.min(8, (a15.volume / Math.max(volBaseline, 1e-6) - env.volumeSpikeMultiplier) * 2));
    else if (a15.volume >= env.minVolumeNative15m) parts.volume = 6;

    if (tradeSpike) parts.trades = Math.min(15, 8 + Math.min(7, a15.trades - tradeBaseline));
    else if (a15.trades >= env.minTrades15m) parts.trades = 5;

    if (sweepActivity) {
        const sev = m.sweepNative15m + m.sweptItems15m * 0.05;
        parts.sweep = Math.min(15, 6 + Math.min(9, sev));
    }

    if (a15.uniqueBuyers >= env.minUniqueBuyers) {
        parts.uniqueBuyers = Math.min(15, 5 + Math.min(10, a15.uniqueBuyers));
    } else if (a15.uniqueBuyers >= 2) {
        parts.uniqueBuyers = 4;
    }

    if (m.trackedWalletBuys15m >= 1) {
        parts.tracked = Math.min(15, 5 + m.trackedWalletBuys15m * 4);
    }

    if (floorUpWithTrades && typeof d30f === 'number') {
        parts.floor = Math.min(10, 4 + Math.min(6, Math.abs(d30f) / 3));
    }

    if (listingsFlatOrDown && m.listingDelta15m !== null && m.listingDelta15m <= 0) {
        parts.listing = 5;
    } else if (listingsFlatOrDown) {
        parts.listing = 2;
    }

    const heavyWash = Math.max(m.heavyWashPairs, a15.heavyPairs);
    const suspiciousScore = (heavyWash >= 2 ? 2 : 0) + (m.thinLiquidity ? 2 : 0);
    if (env.suspiciousActivityPenalty) {
        parts.lowSuspicious = Math.max(0, 5 - suspiciousScore * 2);
    } else {
        parts.lowSuspicious = 3;
    }

    // Penalties
    if (a15.uniqueBuyers < 2) parts.penalties += 12;
    else if (a15.uniqueBuyers < env.minUniqueBuyers) parts.penalties += 6;

    if (m.listingSurgeDuringFloorRise) parts.penalties += 8;

    if (heavyWash >= 1) parts.penalties += heavyWash * 5;

    if (m.thinLiquidity) parts.penalties += 6;

    const mom = momentumConsistency(d10, d30f, d60f);
    if (mom === 'fading') parts.penalties += 4;
    if (mom === 'unstable') parts.penalties += 2;

    const floorMoveNoTrades =
        typeof d30f === 'number' &&
        Math.abs(d30f) > 1 &&
        a15.trades < 2 &&
        a15.volume < env.minVolumeNative15m * 0.25;
    if (floorMoveNoTrades) parts.penalties += 15;

    if (m.dataMissing) parts.penalties += 10;

    const raw =
        parts.volume +
        parts.trades +
        parts.sweep +
        parts.uniqueBuyers +
        parts.tracked +
        parts.floor +
        parts.listing +
        parts.lowSuspicious -
        parts.penalties;

    const scoreClamped = Math.max(0, Math.min(100, Math.round(raw)));

    let suspiciousOverride: ScoredOpportunity['suspiciousOverride'] = 'none';
    if (m.dataMissing && scoreClamped >= env.scoreThreshold) {
        suspiciousOverride = 'insufficient_data';
    } else if (suspiciousScore >= 3 || heavyWash >= 3) {
        suspiciousOverride = 'suspicious_momentum';
    } else if (m.thinLiquidity && a15.volume > 5 && a15.uniqueBuyers <= 2) {
        suspiciousOverride = 'high_risk_pump';
    }

    let riskLabel: ScoredOpportunity['riskLabel'] = 'Low observable risk';
    if (suspiciousOverride !== 'none') {
        riskLabel =
            suspiciousOverride === 'insufficient_data'
                ? 'Insufficient verified data'
                : suspiciousOverride === 'suspicious_momentum'
                  ? 'Suspicious activity'
                  : 'High risk';
    } else if (scoreClamped < 50 || a15.uniqueBuyers < env.minUniqueBuyers) {
        riskLabel = 'Medium risk';
    } else if (mom === 'unstable' || m.listingSurgeDuringFloorRise) {
        riskLabel = 'Medium risk';
    }

    const limitationsCount =
        (m.dataMissing ? 2 : 0) +
        (m.floorNow === null ? 1 : 0) +
        (m.listingDelta15m === null ? 1 : 0);

    const confidence = opportunityConfidence(m.dataMissing, signalCount, limitationsCount);

    const meetsMinActivity =
        a15.trades >= env.minTrades15m &&
        a15.volume >= env.minVolumeNative15m &&
        a15.uniqueBuyers >= env.minUniqueBuyers;

    const two = env.requireTwoSignals ? signalCount >= 2 : signalCount >= 1;

    const floorishOnly =
        gates.floorUpWithTrades &&
        !gates.volumeSpike &&
        !gates.tradeSpike &&
        !gates.sweepActivity &&
        !gates.uniqueBuyerIncrease &&
        !gates.trackedCluster;

    const passesFloorNotAloneRule = !floorishOnly;

    const passesTwoSignalRule = two;

    let signalLevel: OpportunitySignalLevel =
        scoreClamped >= env.strongScoreThreshold ? 'strong' : scoreClamped >= env.scoreThreshold ? 'developing' : 'early';

    let signalLabel = 'Early watch signal';
    if (scoreClamped >= env.strongScoreThreshold) signalLabel = 'Strong momentum signal';
    else if (scoreClamped >= 65) signalLabel = 'Developing opportunity signal';
    else if (scoreClamped >= 50) signalLabel = 'Early watch signal';
    else if (scoreClamped >= 35) signalLabel = 'Weak / unconfirmed';
    else signalLabel = 'Ignore';

    if (suspiciousOverride === 'suspicious_momentum') {
        signalLabel = 'Suspicious momentum';
        signalLevel = 'early';
    } else if (suspiciousOverride === 'high_risk_pump') {
        signalLabel = 'High-risk momentum signal';
        signalLevel = 'developing';
    } else if (suspiciousOverride === 'insufficient_data') {
        signalLabel = 'Insufficient verified data';
        signalLevel = 'early';
    }

    const shouldAlert =
        meetsMinActivity &&
        scoreClamped >= env.scoreThreshold &&
        passesTwoSignalRule &&
        passesFloorNotAloneRule &&
        suspiciousOverride !== 'insufficient_data';

    return {
        score: raw,
        scoreClamped,
        confidence,
        riskLabel,
        signalLabel,
        signalLevel,
        suspiciousOverride,
        gates,
        signalCount,
        meetsMinActivity,
        passesTwoSignalRule,
        passesFloorNotAloneRule,
        shouldAlert,
        parts,
    };
}

export function parseTradeZMembers(flat: string[]): TradeRow[] {
    const out: TradeRow[] = [];
    for (let i = 0; i < flat.length; i += 2) {
        const row = flat[i];
        const tsMs = Number(flat[i + 1]);
        if (!row || !Number.isFinite(tsMs)) continue;
        const p = String(row).split(FS);
        if (p.length < 5) continue;
        const priceNative = Number(p[3]);
        if (!Number.isFinite(priceNative)) continue;
        out.push({
            tsMs,
            buyer: (p[1] || '').toLowerCase(),
            seller: (p[2] || '').toLowerCase(),
            priceNative,
            txHash: (p[4] || '').toLowerCase(),
        });
    }
    return out;
}

export function parseFloorZMembers(flat: string[]): Array<{ tsMs: number; priceNative: number }> {
    const out: Array<{ tsMs: number; priceNative: number }> = [];
    for (const row of flat) {
        const p = String(row).split(FS);
        if (p.length < 2) continue;
        const tsMs = Number(p[0]);
        const priceNative = Number(p[1]);
        if (!Number.isFinite(tsMs) || !Number.isFinite(priceNative)) continue;
        out.push({ tsMs, priceNative });
    }
    return out;
}
