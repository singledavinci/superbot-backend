import test from 'node:test';
import assert from 'node:assert/strict';

import {
    explainClusterBuy,
    explainFloorImpactFollowup,
    explainFloorMovement,
    explainMassDelist,
    explainMassListing,
    explainSweep,
    explainWhale,
    explainHotMint,
} from '../contextualEngine';
import { sanitizeAiOutput } from '../textGuards';

test('Insufficient data surfaces when whale metrics omit price + floor linkage', () => {
    const o = explainWhale({
        behavior: 'buy',
        focalWalletTracked: true,
        priceEth: null,
        currency: 'ETH',
        marketplace: 'blur',
        possibleWashTrading: false,
        distinctWalletsInWindow: 1,
        eventsInWindow: 1,
        windowMinutes: 60,
        floorEth: null,
        floorVsSnapshotPct: null,
        listingSurgeSuspected: false,
        recentTrackedSellsDistinctWallets: 1,
    });
    assert.ok(o.evidence.every(e => typeof e === 'string' && e.trim().length > 0));
    assert.ok(
        o.signal === 'Insufficient data' ||
            o.signal === 'Weak bullish signal' ||
            o.signal === 'Neutral activity',
        `unexpected signal=${o.signal}`,
    );
    assert.ok(o.dataLimitations.length >= 1);
});

test('WHALE_BUY style output includes structured sections', () => {
    const o = explainWhale({
        behavior: 'buy',
        focalWalletTracked: true,
        priceEth: 1.2,
        currency: 'ETH',
        marketplace: 'opensea',
        possibleWashTrading: false,
        distinctWalletsInWindow: 2,
        eventsInWindow: 3,
        windowMinutes: 60,
        floorEth: 1.25,
        floorVsSnapshotPct: 1,
        listingSurgeSuspected: false,
        recentTrackedSellsDistinctWallets: 1,
    });
    assert.ok(o.event && o.context && o.evidence.length && o.risk && o.nextWatch);
});

test('SWEEP cites item count + total spend deterministically', () => {
    const o = explainSweep({
        itemCount: 5,
        totalNative: 2.5,
        currency: 'ETH',
        floorEth: 0.95,
        floorVsSnapshotPct: 0,
    });
    assert.ok(o.evidence.some(l => /5/.test(l) && /ETH/.test(l)));
});

test('CLUSTER_BUY includes wallet count + time window', () => {
    const o = explainClusterBuy({ walletCount: 4, windowMinutes: 20, chain: 'ethereum' });
    assert.ok(o.evidence.some(l => l.includes('4') && l.includes('20')));
    assert.ok(o.evidence.some(l => l.includes('ethereum')));
});

test('MASS_LISTING is not bullish by default', () => {
    const o = explainMassListing({ listingCount: 20, windowMs: 900_000, floorBeforeEth: 1 });
    assert.ok(
        o.signal === 'Neutral activity' ||
            o.signal === 'Weak bearish signal' ||
            o.signal === 'Insufficient data',
    );
});

test('MASS_DELIST mentions supply tightening and uncertainty', () => {
    const o = explainMassDelist({ delistCount: 10, windowMs: 720_000, floorBeforeEth: 1 });
    assert.ok(o.context.toLowerCase().includes('delist'));
    assert.ok(/strategic|cancell/i.test(o.risk));
});

test('HOT_MINT mentions unique participants + totals', () => {
    const o = explainHotMint({
        uniqueMinters: 20,
        totalMints: 30,
        windowMinutes: 10,
        velocityPerMin: 3,
        floorEth: null,
        minUniqueConfigured: 15,
        minTotalConfigured: 25,
    });
    assert.ok(o.evidence.some(l => l.includes('20') && l.includes('30')));
});

test('Floor impact follows recorded before/after', () => {
    const o = explainFloorImpactFollowup({
        originalAlertType: 'MASS_LISTING',
        floorBefore: 1,
        floorAfter: 0.94,
        pctChange: -6,
    });
    const joined = o.evidence.join(' ');
    assert.ok(joined.includes('1.0000') && joined.includes('0.9400'));
});

test('FLOOR_RISE does not promise strong bullish without corroboration', () => {
    const o = explainFloorMovement({
        direction: 'rise',
        floorPrice: 10,
        prevFloor: 9,
        pctChange: 11,
        currency: 'ETH',
        hasCorroboration: false,
    });
    assert.ok(o.signal !== 'Strong bullish signal');
});

test('FLOOR_DROP avoids overselling calamity without context', () => {
    const o = explainFloorMovement({
        direction: 'drop',
        floorPrice: 8,
        prevFloor: 9,
        pctChange: -11,
        currency: 'ETH',
        hasCorroboration: false,
    });
    assert.ok(o.signal !== 'Strong bearish signal');
});

test('sanitizeAi rejects trade imperatives', () => {
    assert.equal(sanitizeAiOutput('please buy immediately'), null);
    assert.equal(sanitizeAiOutput('okay'), 'okay');
});

test('explainWhale does not expose randomness drift', () => {
    const a = explainSweep({
        itemCount: 3,
        totalNative: 1,
        currency: 'ETH',
        floorEth: 1,
        floorVsSnapshotPct: 2,
    });
    const b = explainSweep({
        itemCount: 3,
        totalNative: 1,
        currency: 'ETH',
        floorEth: 1,
        floorVsSnapshotPct: 2,
    });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
});
