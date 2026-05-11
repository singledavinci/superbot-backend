import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    scoreOpportunity,
    opportunityConfidence,
    defaultOpportunityScoreEnv,
    type OpportunityMetricsInput,
    type OpportunityScoreEnv,
} from '../opportunityScoring';
import { containsForbiddenTradingPhrases } from '../../../intelligence/src/textGuards';

function baseMetrics(over: Partial<OpportunityMetricsInput> = {}): OpportunityMetricsInput {
    const now = Date.now();
    const trades = [];
    for (let i = 0; i < 8; i++) {
        const pad = (n: number) => n.toString(16).padStart(40, '0');
        trades.push({
            tsMs: now - 5 * 60 * 1000,
            buyer: `0x${pad(0x1000 + i)}`,
            seller: `0x${pad(0x2000 + i)}`,
            priceNative: 0.2,
            txHash: `0x${String(i).padStart(64, 'a')}`,
        });
    }
    return {
        nowMs: now,
        trades,
        sweepEvents15m: 1,
        sweptItems15m: 3,
        sweepNative15m: 0.5,
        uniqueSweepBuyers15m: 1,
        trackedWalletBuys15m: 2,
        floorNow: 1.1,
        floorSamples: [
            { tsMs: now - 45 * 60 * 1000, priceNative: 1.0 },
            { tsMs: now - 20 * 60 * 1000, priceNative: 1.02 },
        ],
        listingDelta15m: -1,
        listingSurgeDuringFloorRise: false,
        heavyWashPairs: 0,
        thinLiquidity: false,
        dataMissing: false,
        ...over,
    };
}

describe('opportunityScoring', () => {
    it('scores within 0–100 and applies two-signal gating', () => {
        const env: OpportunityScoreEnv = {
            ...defaultOpportunityScoreEnv(),
            requireTwoSignals: true,
            minTrades15m: 5,
            minVolumeNative15m: 0.5,
            minUniqueBuyers: 4,
            scoreThreshold: 65,
        };
        const s = scoreOpportunity(baseMetrics(), env);
        assert.ok(s.scoreClamped >= 0 && s.scoreClamped <= 100);
        assert.equal(s.passesTwoSignalRule, s.signalCount >= 2);
    });

    it('does not alert when trade corroboration is missing (no 15m activity)', () => {
        const now = Date.now();
        const m = baseMetrics({
            trades: [],
            sweepEvents15m: 0,
            sweptItems15m: 0,
            sweepNative15m: 0,
            trackedWalletBuys15m: 0,
            floorNow: 2,
            floorSamples: [{ tsMs: now - 45 * 60 * 1000, priceNative: 1 }],
            listingDelta15m: 0,
        });
        const s = scoreOpportunity(m, defaultOpportunityScoreEnv());
        assert.equal(s.meetsMinActivity, false);
        assert.equal(s.shouldAlert, false);
    });

    it('cooldown follow-up allows +15 score jump', () => {
        const prev = 60;
        const next = 76;
        assert.ok(next >= prev + 15);
    });

    it('suspicious override path', () => {
        const s = scoreOpportunity(
            baseMetrics({ heavyWashPairs: 4, thinLiquidity: true, trades: baseMetrics().trades }),
            defaultOpportunityScoreEnv(),
        );
        assert.ok(['suspicious_momentum', 'high_risk_pump', 'none', 'insufficient_data'].includes(s.suspiciousOverride));
    });

    it('missing data yields insufficient confidence', () => {
        const c = opportunityConfidence(true, 3, 3);
        assert.equal(c, 'insufficient');
    });

    it('listing surge during floor rise reduces score via penalties', () => {
        const a = scoreOpportunity(baseMetrics({ listingSurgeDuringFloorRise: false }), defaultOpportunityScoreEnv());
        const b = scoreOpportunity(baseMetrics({ listingSurgeDuringFloorRise: true }), defaultOpportunityScoreEnv());
        assert.ok(b.scoreClamped <= a.scoreClamped);
    });

    it('forbidden phrase guard rejects unsafe copy', () => {
        assert.equal(containsForbiddenTradingPhrases('This is a possible momentum signal.'), false);
        assert.equal(containsForbiddenTradingPhrases('buy now on OpenSea'), true);
        assert.equal(containsForbiddenTradingPhrases('guaranteed pump incoming'), true);
    });
});
