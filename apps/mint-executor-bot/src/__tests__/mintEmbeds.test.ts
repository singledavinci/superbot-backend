import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMintPreflightEmbed, buildMintJobResultEmbed } from '../lib/mintEmbeds';

describe('mintEmbeds', () => {
    it('buildMintPreflightEmbed maps unsignedPrepare and simulation', () => {
        const j: Record<string, unknown> = {
            ok: true,
            executionMode: 'prepare',
            resolverStatus: 'ok',
            planHash: 'abc',
            simulation: { status: 'PASS' },
            unsignedPrepare: { kind: 'unsigned_eip1559_tx', chainId: 1, to: '0xsea', value: '1' },
            verifiedDrop: {
                dropType: 'public',
                seaDropContract: '0xsea',
                priceNative: '1000',
                startTime: 1,
                endTime: null,
            },
            livePolicy: 'BLOCK_SIMULATION',
            persistJobId: null,
            signingOccurred: false,
            broadcastOccurred: false,
        };
        const e = buildMintPreflightEmbed(j);
        const names = (e.toJSON().fields ?? []).map(f => f.name);
        assert.ok(names.includes('unsignedPrepare'));
        assert.ok(names.includes('simulationStatus'));
        assert.ok(names.includes('planHash'));
        assert.ok(names.includes('blockReason'));
    });

    it('buildMintJobResultEmbed surfaces metadata blockReason', () => {
        const payload = {
            job: {
                id: 'jid',
                status: 'preflight_passed',
                executionMode: 'prepare',
                planHash: 'ph',
                simulationStatus: 'PASS',
                errorCode: null,
                metadataJson: {
                    preflightLast: {
                        blockReason: null,
                        unsignedPreparePresent: true,
                        signingOccurred: false,
                        broadcastOccurred: false,
                    },
                },
                simulations: [{ status: 'PASS' }],
            },
        };
        const e = buildMintJobResultEmbed(payload);
        const names = (e.toJSON().fields ?? []).map(f => f.name);
        assert.ok(names.includes('blockReason (metadata)'));
    });

    it('buildMintJobResultEmbed maps blockReason for failed preflight', () => {
        const payload = {
            job: {
                id: 'jid',
                status: 'preflight_failed',
                executionMode: 'prepare',
                planHash: 'ph',
                simulationStatus: 'FAIL_REVERT',
                errorCode: 'FAIL_REVERT',
                metadataJson: {
                    preflightLast: {
                        blockReason: 'Simulation reverted (out of gas)',
                        unsignedPreparePresent: true,
                        signingOccurred: false,
                        broadcastOccurred: false,
                    },
                },
                simulations: [{ status: 'FAIL_REVERT' }],
            },
        };
        const e = buildMintJobResultEmbed(payload);
        const fields = e.toJSON().fields ?? [];
        const br = fields.find(f => f.name === 'blockReason (metadata)');
        assert.ok(br?.value?.includes('reverted'));
    });
});
