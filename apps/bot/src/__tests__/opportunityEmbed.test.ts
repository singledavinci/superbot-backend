import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunitySpikeEmbed } from '../embeds';
import { explainOpportunitySpike } from '../../../../packages/intelligence/src/contextualEngine';

test('OPPORTUNITY_SPIKE embed footer includes required disclaimer', () => {
    const cx = explainOpportunitySpike({
        collectionLabel: 'Test Collection',
        windowLabel: '15m',
        score: 72,
        signalLabel: 'Developing opportunity signal',
        confidenceLabel: 'medium',
        riskLabel: 'Medium risk',
        evidenceLines: ['Sample evidence line for tests.'],
        limitations: [],
    });
    const embed = createOpportunitySpikeEmbed({
        collectionName: 'Test Collection',
        contract: '0x0000000000000000000000000000000000000001',
        chain: 'ethereum',
        timeWindow: '15m',
        score: 72,
        signal: 'Developing opportunity signal',
        confidence: 'Medium',
        volumeChange: 'n/a',
        tradeCount: '5',
        uniqueBuyers: '4',
        sweepActivity: 'none',
        floorChange: 'n/a',
        listingPressure: '0',
        trackedWalletActivity: '0',
        riskFlags: 'Medium risk',
        dataLimitations: 'Test limitations',
        contextualExplanation: cx,
    });
    const json = embed.toJSON();
    const footer = json.footer?.text ?? '';
    assert.ok(footer.includes('Not financial advice'));
});
