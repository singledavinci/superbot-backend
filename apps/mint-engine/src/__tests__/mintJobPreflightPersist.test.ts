import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@superbot/database';
import {
    mergeMintJobMetadataJson,
    persistMintJobPreflightFields,
    unsignedPrepareMetadata,
} from '../engine/mintJobPreflightPersist';

describe('mintJobPreflightPersist', () => {
    it('unsignedPrepareMetadata does not include full calldata', () => {
        const m = unsignedPrepareMetadata({
            kind: 'unsigned_eip1559_tx',
            chainId: 1,
            to: '0xabc',
            data: '0x' + '12'.repeat(100),
            value: '1',
            gasLimit: '21000',
            maxFeePerGas: '0',
            maxPriorityFeePerGas: '0',
            mintFunction: 'mintPublic',
            nftContract: '0xnft',
        });
        assert.equal(m.calldataLength, 202);
        assert.ok(typeof m.calldataPrefix === 'string');
    });

    it('persistMintJobPreflightFields merges metadata and sets plan fields', async () => {
        const updates: Array<{ planHash?: string; simulationStatus?: string; metadataJson?: object }> = [];
        const prisma = {
            mintJob: {
                findUnique: async () => ({ metadataJson: { existing: true } }),
                update: async ({ data }: { data: (typeof updates)[number] }) => {
                    updates.push(data);
                    return {};
                },
            },
        } as unknown as PrismaClient;
        await persistMintJobPreflightFields({
            prisma,
            mintJobId: 'job-1',
            planHash: 'deadbeef',
            simulationStatus: 'PASS',
            errorCode: null,
            executionMode: 'prepare',
            unsignedPrepare: { kind: 'unsigned_eip1559_tx', chainId: 1, to: '0xt', data: '0x01', value: '0', gasLimit: '1', maxFeePerGas: '0', maxPriorityFeePerGas: '0' },
            blockReason: null,
        });
        assert.equal(updates.length, 1);
        assert.equal(updates[0].planHash, 'deadbeef');
        assert.equal(updates[0].simulationStatus, 'PASS');
        const meta = updates[0].metadataJson as { preflightLast: { unsignedPreparePresent: boolean; signingOccurred: boolean } };
        assert.equal(meta.preflightLast.unsignedPreparePresent, true);
        assert.equal(meta.preflightLast.signingOccurred, false);
    });

    it('mergeMintJobMetadataJson preserves prior keys', async () => {
        let saved: object = {};
        const prisma = {
            mintJob: {
                findUnique: async () => ({ metadataJson: { a: 1 } }),
                update: async ({ data }: { data: { metadataJson: object } }) => {
                    saved = data.metadataJson;
                    return {};
                },
            },
        } as unknown as PrismaClient;
        await mergeMintJobMetadataJson(prisma, 'id', { b: 2 });
        assert.deepEqual(saved, { a: 1, b: 2 });
    });
});
