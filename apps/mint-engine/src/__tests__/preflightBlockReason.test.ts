import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { preflightBlockReasonFromCode, simulationBlockReason } from '../engine/preflightBlockReason';

describe('preflightBlockReason', () => {
    it('maps unknown price and function', () => {
        assert.match(preflightBlockReasonFromCode('FAIL_UNKNOWN_PRICE'), /price/i);
        assert.match(preflightBlockReasonFromCode('FAIL_UNKNOWN_FUNCTION'), /function/i);
    });

    it('maps degraded provider / missing RPC', () => {
        assert.match(preflightBlockReasonFromCode('DEGRADED_PROVIDER_ERROR', 'NO_HTTPS_RPC'), /RPC|Provider/i);
    });

    it('simulationBlockReason returns null on pass', () => {
        assert.equal(simulationBlockReason('PASS'), null);
        assert.equal(simulationBlockReason('PASS_STAGE_NOT_OPEN_YET'), null);
    });

    it('simulationBlockReason describes revert', () => {
        const r = simulationBlockReason('FAIL_REVERT', 'execution reverted');
        assert.ok(r && r.includes('reverted'));
    });
});
