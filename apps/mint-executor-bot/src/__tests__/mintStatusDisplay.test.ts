import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildMintStatusDescription,
    displayHealthField,
    formatMintStatusEngineFailure,
} from '../lib/mintStatusDisplay';

describe('mintStatusDisplay', () => {
    it('never renders undefined as text', () => {
        assert.equal(displayHealthField(undefined), 'missing');
        assert.equal(displayHealthField(null), 'missing');
        assert.ok(!buildMintStatusDescription({}).includes('undefined'));
    });

    it('renders real values from a full health payload', () => {
        const desc = buildMintStatusDescription({
            mode: 'live',
            executionEnabled: true,
            mainnetBroadcastEnabled: true,
            emergencyStop: false,
            testnetOnly: false,
            signerConfigured: false,
            defaultChainId: 1,
            mainnetBeta: true,
            mainnetDryRun: true,
            copyMintLiveEnabled: false,
            privateRelayEnabled: false,
            autoReplaceEnabled: false,
            manualConfirmationRequired: true,
            maxActiveJobs: 1,
            maxQuantity: 1,
        });
        assert.ok(desc.includes('Mode: **live**'));
        assert.ok(desc.includes('Mainnet beta: **true**'));
        assert.ok(desc.includes('Max quantity: **1**'));
        assert.ok(!desc.includes('undefined'));
    });

    it('shows missing when a field is absent', () => {
        const desc = buildMintStatusDescription({ mode: 'live' });
        assert.ok(desc.includes('missing'));
        assert.ok(desc.includes('Mainnet beta: **missing**'));
    });

    it('formats network failure with MINT_ENGINE_URL hint', () => {
        const s = formatMintStatusEngineFailure({ kind: 'network', message: 'ECONNREFUSED' });
        assert.ok(s.includes('Engine reachable: **no**'));
        assert.ok(s.includes('MINT_ENGINE_URL'));
    });

    it('formats network failure with engine host when provided', () => {
        const s = formatMintStatusEngineFailure({
            kind: 'network',
            message: 'ECONNREFUSED',
            engineHost: 'superbot-mint-engine-production.up.railway.app',
        });
        assert.ok(s.includes('Engine URL host: **superbot-mint-engine-production.up.railway.app**'));
    });

    it('formats auth failure for 401/403-style responses', () => {
        const s = formatMintStatusEngineFailure({
            kind: 'auth',
            message: 'invalid_hmac',
            httpStatus: 401,
            bodySnippet: '{"error":"unauthorized"}',
        });
        assert.ok(s.includes('Engine auth failed'));
        assert.ok(s.includes('401'));
        assert.ok(!s.includes('undefined'));
    });

    it('formats HTTP failure with status', () => {
        const s = formatMintStatusEngineFailure({
            kind: 'http',
            message: 'bad_gateway',
            httpStatus: 502,
            bodySnippet: '{"error":"upstream"}',
        });
        assert.ok(s.includes('Engine reachable: **yes**'));
        assert.ok(s.includes('502'));
    });
});
