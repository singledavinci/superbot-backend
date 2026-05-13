import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildMintStatusDescription,
    computeMainnetProofReadiness,
    displayHealthField,
    formatMintExecutorEnvUnreachable,
    formatMintStatusEngineFailure,
    formatStatusValue,
    isMintHealthPayloadIncomplete,
    pickStatusField,
    statusKeyExists,
} from '../lib/mintStatusDisplay';

describe('mintStatusDisplay', () => {
    it('formatStatusValue never renders undefined as text', () => {
        assert.equal(formatStatusValue(undefined), 'missing');
        assert.equal(formatStatusValue(null), 'missing');
        assert.equal(formatStatusValue('undefined'), 'missing');
        assert.equal(formatStatusValue('  undefined  '), 'missing');
        assert.equal(formatStatusValue(false), 'false');
        assert.equal(formatStatusValue(true), 'true');
        assert.equal(formatStatusValue(0), '0');
        assert.equal(displayHealthField(undefined), 'missing');
        assert.ok(!buildMintStatusDescription({}).includes('undefined'));
    });

    it('maps POST /status-style keys (engineMode, liveExecutionEnabled)', () => {
        const desc = buildMintStatusDescription(
            {
                engineMode: 'live',
                liveExecutionEnabled: true,
                mainnetBroadcastEnabled: true,
                emergencyStopEffective: false,
                testnetOnly: false,
                signerConfigured: true,
                signerMode: 'simulation-only',
                signerMainnetApproved: false,
                signerAddressMasked: null,
                defaultChainId: 1,
                mainnetBetaEnabled: true,
                mainnetDryRunEnabled: false,
                mainnetMaxActiveJobs: 1,
                mainnetMaxQuantity: 1,
                healthSchemaVersion: 3,
                runtimeEmergencyStopAvailable: true,
                copyMintLiveEnabled: false,
                privateRelayEnabled: false,
                autoReplaceEnabled: false,
                manualConfirmationRequired: true,
            },
            { postStatusMerge: 'used' },
        );
        assert.ok(desc.includes('Mode: **live**'));
        assert.ok(desc.includes('Live execution flag: **true**'));
        assert.ok(!desc.includes('undefined'));
    });

    it('pickStatusField prefers first present key', () => {
        assert.equal(pickStatusField({ mode: 'live', engineMode: 'prepare' }, ['mode', 'engineMode']), 'live');
        assert.equal(pickStatusField({ engineMode: 'live' }, ['mode', 'engineMode']), 'live');
    });

    it('renders real values from a full health payload', () => {
        const desc = buildMintStatusDescription(
            {
                healthSchemaVersion: 3,
                runtimeEmergencyStopAvailable: true,
                mode: 'live',
                executionEnabled: true,
                mainnetBroadcastEnabled: true,
                emergencyStop: false,
                testnetOnly: false,
                signerConfigured: false,
                signerMode: 'simulation-only',
                signerMainnetApproved: false,
                signerAddressMasked: null,
                defaultChainId: 1,
                mainnetBeta: true,
                mainnetDryRun: true,
                copyMintLiveEnabled: false,
                privateRelayEnabled: false,
                autoReplaceEnabled: false,
                manualConfirmationRequired: true,
                maxActiveJobs: 1,
                maxQuantity: 1,
            },
            { postStatusMerge: 'used' },
        );
        assert.ok(desc.includes('Mode: **live**'));
        assert.ok(desc.includes('Mainnet beta: **true**'));
        assert.ok(desc.includes('Max quantity: **1**'));
        assert.ok(desc.includes('Health schema: **3**'));
        assert.ok(desc.includes('Signer configured: **false**'));
        assert.ok(desc.includes('Signer mode: **simulation-only**'));
        assert.ok(desc.includes('Mainnet proof readiness: **not ready**'));
        assert.ok(desc.includes('First blocker: **signer not configured**'));
        assert.ok(!desc.includes('undefined'));
    });

    it('shows missing when a field is absent', () => {
        const desc = buildMintStatusDescription({ mode: 'live' }, { postStatusMerge: 'skipped' });
        assert.ok(desc.includes('missing'));
        assert.ok(desc.includes('Mainnet beta: **missing**'));
        assert.ok(desc.includes('Status payload incomplete'));
        assert.ok(desc.includes('mainnetProofReady: **false**'));
    });

    it('warns when POST /status merge auth fails', () => {
        const desc = buildMintStatusDescription(
            {
                mode: 'live',
                executionEnabled: true,
                mainnetBroadcastEnabled: true,
                mainnetBeta: true,
                emergencyStop: false,
                testnetOnly: false,
                signerConfigured: true,
                signerMode: 'external-signer',
                signerMainnetApproved: true,
                signerAddressMasked: '0xaaaa...bbbb',
                defaultChainId: 1,
                maxActiveJobs: 1,
                maxQuantity: 1,
                copyMintLiveEnabled: false,
                privateRelayEnabled: false,
                healthSchemaVersion: 3,
                runtimeEmergencyStopAvailable: true,
                mainnetDryRun: false,
                autoReplaceEnabled: false,
                manualConfirmationRequired: true,
            },
            { postStatusMerge: 'auth_failed', postHttpStatus: 401 },
        );
        assert.ok(desc.includes('auth failed'));
        assert.ok(desc.includes('401'));
    });

    it('mainnet proof ready only when every gate passes', () => {
        const readyPayload = {
            healthSchemaVersion: 3,
            runtimeEmergencyStopAvailable: true,
            mode: 'live',
            executionEnabled: true,
            mainnetBroadcastEnabled: true,
            mainnetBeta: true,
            mainnetDryRun: false,
            emergencyStop: false,
            testnetOnly: false,
            signerConfigured: true,
            signerMode: 'external-signer',
            signerMainnetApproved: true,
            signerAddressMasked: '0x1111...2222',
            defaultChainId: 1,
            maxActiveJobs: 1,
            maxQuantity: 1,
            copyMintLiveEnabled: false,
            privateRelayEnabled: false,
            autoReplaceEnabled: false,
            manualConfirmationRequired: true,
        };
        const r = computeMainnetProofReadiness(readyPayload);
        assert.equal(r.ready, true);
        assert.equal(r.blockers.length, 0);
        const desc = buildMintStatusDescription(readyPayload, { postStatusMerge: 'used' });
        assert.ok(desc.includes('Mainnet proof readiness: **ready**'));
    });

    it('mainnet proof not ready when signer configured but not mainnet approved', () => {
        const j = {
            healthSchemaVersion: 3,
            runtimeEmergencyStopAvailable: true,
            mode: 'live',
            executionEnabled: true,
            mainnetBroadcastEnabled: true,
            mainnetBeta: true,
            mainnetDryRun: false,
            emergencyStop: false,
            testnetOnly: false,
            signerConfigured: true,
            signerMode: 'external-signer',
            signerMainnetApproved: false,
            signerAddressMasked: '0xabcd...ef01',
            copyMintLiveEnabled: false,
            privateRelayEnabled: false,
            autoReplaceEnabled: false,
            manualConfirmationRequired: true,
            defaultChainId: 1,
            maxActiveJobs: 1,
            maxQuantity: 1,
        };
        const r = computeMainnetProofReadiness(j);
        assert.equal(r.ready, false);
        assert.equal(r.blockers[0], 'signer not mainnet approved');
        const desc = buildMintStatusDescription(j, { postStatusMerge: 'used' });
        assert.ok(desc.includes('First blocker: **signer not mainnet approved**'));
    });

    it('statusKeyExists treats null as present', () => {
        assert.equal(statusKeyExists({ signerAddressMasked: null }, ['signerAddressMasked']), true);
    });

    it('isMintHealthPayloadIncomplete detects missing required keys', () => {
        assert.equal(isMintHealthPayloadIncomplete({ mode: 'live' }), true);
        assert.equal(
            isMintHealthPayloadIncomplete({
                mode: 'live',
                executionEnabled: true,
                mainnetBroadcastEnabled: true,
                mainnetBeta: true,
                emergencyStop: false,
                testnetOnly: false,
                signerConfigured: true,
                signerMode: 'external-signer',
                signerMainnetApproved: true,
                signerAddressMasked: '0x0000...0001',
                defaultChainId: 1,
            }),
            false,
        );
    });

    it('formats executor unreachable env block', () => {
        const s = formatMintExecutorEnvUnreachable('MINT_ENGINE_URL missing');
        assert.ok(s.includes('Engine reachable: **no**'));
        assert.ok(s.includes('Reason: **MINT_ENGINE_URL missing**'));
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
