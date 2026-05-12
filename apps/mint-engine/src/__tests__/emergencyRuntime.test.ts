import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mintEnv } from '../config/mintEnv';
import { getEffectiveEmergencyStop, setRuntimeEmergencyStop } from '../engine/emergencyRuntime';

describe('emergencyRuntime', () => {
    it('getEffectiveEmergencyStop returns true from env without querying DB', async () => {
        const prev = mintEnv.MINT_EMERGENCY_STOP;
        mintEnv.MINT_EMERGENCY_STOP = true;
        let dbTouched = false;
        const prisma = {
            mintEngineRuntimeState: {
                findUnique: async () => {
                    dbTouched = true;
                    return null;
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;
        try {
            const out = await getEffectiveEmergencyStop(prisma);
            assert.equal(out, true);
            assert.equal(dbTouched, false);
        } finally {
            mintEnv.MINT_EMERGENCY_STOP = prev;
        }
    });

    it('getEffectiveEmergencyStop returns true when DB runtime flag is true', async () => {
        const prisma = {
            mintEngineRuntimeState: {
                findUnique: async () => ({ id: 'default', emergencyStop: true }),
            },
        } as unknown as import('@superbot/database').PrismaClient;
        const out = await getEffectiveEmergencyStop(prisma);
        assert.equal(out, true);
    });

    it('setRuntimeEmergencyStop upserts default runtime row', async () => {
        let calledWith: unknown = null;
        const prisma = {
            mintEngineRuntimeState: {
                upsert: async (args: unknown) => {
                    calledWith = args;
                    return { id: 'default', emergencyStop: true };
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;

        await setRuntimeEmergencyStop(prisma, true);
        assert.ok(calledWith && typeof calledWith === 'object');
        const q = calledWith as {
            where?: Record<string, unknown>;
            create?: Record<string, unknown>;
            update?: Record<string, unknown>;
        };
        assert.deepEqual(q.where, { id: 'default' });
        assert.deepEqual(q.create, { id: 'default', emergencyStop: true });
        assert.deepEqual(q.update, { emergencyStop: true });
    });
});
