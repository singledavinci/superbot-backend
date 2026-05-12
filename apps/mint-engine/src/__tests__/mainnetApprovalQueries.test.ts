import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectionAllowedByApproval, findActiveMainnetApproval } from '../engine/mainnetApprovalQueries';

describe('mainnetApprovalQueries — collectionAllowedByApproval', () => {
    it('allows when allowedCollections is nullish/non-array/empty', () => {
        assert.equal(collectionAllowedByApproval(null, '0xabc'), true);
        assert.equal(collectionAllowedByApproval(undefined, '0xabc'), true);
        assert.equal(collectionAllowedByApproval({ any: 'shape' }, '0xabc'), true);
        assert.equal(collectionAllowedByApproval([], '0xabc'), true);
    });

    it('matches case-insensitively when allow-list exists', () => {
        assert.equal(collectionAllowedByApproval(['0xAbC', '0xdef'], '0xabc'), true);
        assert.equal(collectionAllowedByApproval(['0xAbC', '0xdef'], '0xdef'), true);
    });

    it('blocks when collection not present in non-empty allow-list', () => {
        assert.equal(collectionAllowedByApproval(['0xaaa', '0xbbb'], '0xccc'), false);
    });
});

describe('mainnetApprovalQueries — findActiveMainnetApproval', () => {
    it('queries active, non-expired approval scoped to wallet+guild+user', async () => {
        let calledArgs: unknown = null;
        const expected = {
            id: 'appr_1',
            maxFeePerGas: '100',
            maxPriorityFeePerGas: '2',
            maxTotalCostNative: '0.05',
            maxQuantity: 1,
            allowedCollections: ['0xabc'],
        };
        const prisma = {
            mainnetExecutionApproval: {
                findFirst: async (args: unknown) => {
                    calledArgs = args;
                    return expected;
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;

        const out = await findActiveMainnetApproval(prisma, {
            userId: 'u_1',
            guildId: 'g_1',
            mintWalletId: 'w_1',
        });

        assert.deepEqual(out, expected);
        assert.ok(calledArgs && typeof calledArgs === 'object');
        const q = calledArgs as { where?: Record<string, unknown>; orderBy?: Record<string, unknown> };
        assert.equal(q.where?.userId, 'u_1');
        assert.equal(q.where?.guildId, 'g_1');
        assert.equal(q.where?.mintWalletId, 'w_1');
        assert.equal(q.where?.approvalStatus, 'active');
        assert.equal(typeof (q.where?.expiresAt as { gt?: unknown })?.gt, 'object');
        assert.deepEqual(q.orderBy, { expiresAt: 'desc' });
    });
});
