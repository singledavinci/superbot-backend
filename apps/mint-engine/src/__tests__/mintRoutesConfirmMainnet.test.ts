import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Router } from 'express';
import { registerMintRoutes } from '../http/mintRoutes';
import { mintEnv } from '../config/mintEnv';

type CapturedHandler = (req: { body?: unknown }, res: MockRes) => void;

type MockRes = {
    statusCode: number;
    body: unknown;
    status: (code: number) => MockRes;
    json: (payload: unknown) => void;
};

function createMockRes(done: () => void): MockRes {
    return {
        statusCode: 200,
        body: null,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: unknown) {
            this.body = payload;
            done();
        },
    };
}

function buildRouteHarness(prisma: import('@superbot/database').PrismaClient, routePath: string): CapturedHandler {
    const handlers = new Map<string, CapturedHandler>();
    const app = {
        post(path: string, handler: CapturedHandler) {
            handlers.set(path, handler);
        },
    } as unknown as Router;
    registerMintRoutes(app, { prisma, redis: null, rpcUrl: null });
    const h = handlers.get(routePath);
    if (!h) throw new Error(`Missing ${routePath} route`);
    return h;
}

async function invoke(handler: CapturedHandler, body: Record<string, unknown>): Promise<{ statusCode: number; body: unknown }> {
    return await new Promise<{ statusCode: number; body: unknown }>((resolve) => {
        const res = createMockRes(() => resolve({ statusCode: res.statusCode, body: res.body }));
        handler({ body }, res);
    });
}

after(async () => {
    // `mintRoutes` imports queue singletons that keep Redis handles open in tests.
    const q = await import('@superbot/queue');
    await Promise.all([
        q.eventQueue.close(),
        q.discordQueue.close(),
        q.walletActionBatchQueue.close(),
        q.floorImpactQueue.close(),
        q.mintExecutionQueue.close(),
        q.mintTriggersQueue.close(),
        q.mintNotificationsQueue.close(),
    ]);
    await q.redisConnection.quit();
});

describe('mintRoutes /jobs/confirm-mainnet', () => {
    it('returns 400 when jobId is missing', async () => {
        const prevAdmins = [...mintEnv.MINT_ADMIN_DISCORD_IDS];
        mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, 'admin_1');
        let findUniqueCalled = false;
        const prisma = {
            mintJob: {
                findUnique: async () => {
                    findUniqueCalled = true;
                    return null;
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;
        try {
            const handler = buildRouteHarness(prisma, '/jobs/confirm-mainnet');
            const out = await invoke(handler, { adminDiscordId: 'admin_1' });
            assert.equal(out.statusCode, 400);
            assert.deepEqual(out.body, { error: 'JOB_ID_REQUIRED' });
            assert.equal(findUniqueCalled, false);
        } finally {
            mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, ...prevAdmins);
        }
    });

    it('returns 403 when caller is not an admin', async () => {
        const prevAdmins = [...mintEnv.MINT_ADMIN_DISCORD_IDS];
        mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, 'admin_1');
        let findUniqueCalled = false;
        const prisma = {
            mintJob: {
                findUnique: async () => {
                    findUniqueCalled = true;
                    return null;
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;
        try {
            const handler = buildRouteHarness(prisma, '/jobs/confirm-mainnet');
            const out = await invoke(handler, { adminDiscordId: 'not_admin', jobId: 'j_1' });
            assert.equal(out.statusCode, 403);
            assert.deepEqual(out.body, { error: 'MINT_ADMIN_REQUIRED' });
            assert.equal(findUniqueCalled, false);
        } finally {
            mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, ...prevAdmins);
        }
    });

    it('returns 400 when job is not chainId=1 live', async () => {
        const prevAdmins = [...mintEnv.MINT_ADMIN_DISCORD_IDS];
        mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, 'admin_1');
        const prisma = {
            mintJob: {
                findUnique: async () => ({ id: 'j_1', chainId: 11155111, executionMode: 'live' }),
            },
        } as unknown as import('@superbot/database').PrismaClient;
        try {
            const handler = buildRouteHarness(prisma, '/jobs/confirm-mainnet');
            const out = await invoke(handler, { adminDiscordId: 'admin_1', jobId: 'j_1' });
            assert.equal(out.statusCode, 400);
            assert.deepEqual(out.body, { error: 'MAINNET_LIVE_JOB_REQUIRED' });
        } finally {
            mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, ...prevAdmins);
        }
    });

    it('writes metadata confirmation and returns ok for admin on mainnet live job', async () => {
        const prevAdmins = [...mintEnv.MINT_ADMIN_DISCORD_IDS];
        mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, 'admin_1');
        let findCount = 0;
        let updatedMetadata: unknown = null;
        const prisma = {
            mintJob: {
                findUnique: async (args: { select?: unknown }) => {
                    findCount++;
                    if (args && 'select' in args) {
                        return { metadataJson: { existing: true } };
                    }
                    return { id: 'j_1', chainId: 1, executionMode: 'live' };
                },
                update: async (args: { data?: { metadataJson?: unknown } }) => {
                    updatedMetadata = args.data?.metadataJson ?? null;
                    return { id: 'j_1' };
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;
        try {
            const handler = buildRouteHarness(prisma, '/jobs/confirm-mainnet');
            const out = await invoke(handler, { adminDiscordId: 'admin_1', jobId: 'j_1' });
            assert.equal(out.statusCode, 200);
            assert.deepEqual(out.body, { ok: true, jobId: 'j_1' });
            assert.equal(findCount >= 2, true);
            assert.equal(typeof updatedMetadata, 'object');
            const meta = updatedMetadata as Record<string, unknown>;
            assert.equal(meta.existing, true);
            assert.equal(meta.mainnetConfirmed, true);
            assert.equal(meta.mainnetConfirmedByDiscordId, 'admin_1');
            assert.equal(typeof meta.mainnetConfirmedAt, 'string');
        } finally {
            mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, ...prevAdmins);
        }
    });
});

describe('mintRoutes /runtime emergency controls', () => {
    it('emergency-stop returns 403 for non-admin', async () => {
        const prevAdmins = [...mintEnv.MINT_ADMIN_DISCORD_IDS];
        mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, 'admin_1');
        let upsertCalled = false;
        const prisma = {
            mintEngineRuntimeState: {
                upsert: async () => {
                    upsertCalled = true;
                    return { id: 'default', emergencyStop: true };
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;
        try {
            const handler = buildRouteHarness(prisma, '/runtime/emergency-stop');
            const out = await invoke(handler, { adminDiscordId: 'not_admin' });
            assert.equal(out.statusCode, 403);
            assert.deepEqual(out.body, { error: 'MINT_ADMIN_REQUIRED' });
            assert.equal(upsertCalled, false);
        } finally {
            mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, ...prevAdmins);
        }
    });

    it('emergency-stop writes runtime state and returns effective true', async () => {
        const prevAdmins = [...mintEnv.MINT_ADMIN_DISCORD_IDS];
        mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, 'admin_1');
        let upsertPayload: unknown = null;
        const prisma = {
            mintEngineRuntimeState: {
                upsert: async (args: unknown) => {
                    upsertPayload = args;
                    return { id: 'default', emergencyStop: true };
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;
        try {
            const handler = buildRouteHarness(prisma, '/runtime/emergency-stop');
            const out = await invoke(handler, { adminDiscordId: 'admin_1' });
            assert.equal(out.statusCode, 200);
            assert.deepEqual(out.body, { ok: true, emergencyStopEffective: true });
            assert.ok(upsertPayload && typeof upsertPayload === 'object');
        } finally {
            mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, ...prevAdmins);
        }
    });

    it('emergency-resume writes false and returns effective value from runtime state', async () => {
        const prevAdmins = [...mintEnv.MINT_ADMIN_DISCORD_IDS];
        mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, 'admin_1');
        let upsertPayload: unknown = null;
        let findUniqueCalled = false;
        const prisma = {
            mintEngineRuntimeState: {
                upsert: async (args: unknown) => {
                    upsertPayload = args;
                    return { id: 'default', emergencyStop: false };
                },
                findUnique: async () => {
                    findUniqueCalled = true;
                    return { id: 'default', emergencyStop: false };
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;
        try {
            const handler = buildRouteHarness(prisma, '/runtime/emergency-resume');
            const out = await invoke(handler, { adminDiscordId: 'admin_1' });
            assert.equal(out.statusCode, 200);
            assert.deepEqual(out.body, { ok: true, emergencyStopEffective: false });
            assert.ok(upsertPayload && typeof upsertPayload === 'object');
            assert.equal(findUniqueCalled, true);
        } finally {
            mintEnv.MINT_ADMIN_DISCORD_IDS.splice(0, mintEnv.MINT_ADMIN_DISCORD_IDS.length, ...prevAdmins);
        }
    });
});
