import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@superbot/database';
import { buildMintEngineHealthPayload } from '../http/mintEngineHealthPayload';

const REQUIRED_KEYS = [
    'ok',
    'service',
    'mode',
    'executionEnabled',
    'mainnetBroadcastEnabled',
    'mainnetBeta',
    'mainnetDryRun',
    'emergencyStop',
    'testnetOnly',
    'signerConfigured',
    'defaultChainId',
    'copyMintLiveEnabled',
    'privateRelayEnabled',
    'autoReplaceEnabled',
    'manualConfirmationRequired',
    'maxActiveJobs',
    'maxQuantity',
] as const;

describe('mintEngineHealthPayload', () => {
    it('returns all expected status fields', async () => {
        const prisma = {
            mintEngineRuntimeState: {
                findUnique: async () => null,
            },
        } as unknown as PrismaClient;
        const p = await buildMintEngineHealthPayload(prisma);
        for (const k of REQUIRED_KEYS) {
            assert.ok(k in p, `missing key ${k}`);
        }
        assert.equal(p.ok, true);
        assert.equal(p.service, 'mint-engine');
        assert.equal(typeof p.mode, 'string');
        assert.equal(typeof p.executionEnabled, 'boolean');
        assert.equal(typeof p.defaultChainId, 'number');
        assert.equal(typeof p.maxActiveJobs, 'number');
        assert.equal(typeof p.maxQuantity, 'number');
    });

    it('does not expose secrets or URLs in JSON keys', async () => {
        const prisma = {
            mintEngineRuntimeState: {
                findUnique: async () => null,
            },
        } as unknown as PrismaClient;
        const p = await buildMintEngineHealthPayload(prisma);
        const raw = JSON.stringify(p).toLowerCase();
        const forbidden = ['opensea_api_key', 'mint_engine_service_secret', 'database_url', 'redis_url', 'private_key', 'rpc_url', 'alchemy', 'infura'];
        for (const f of forbidden) {
            assert.equal(raw.includes(f), false, `forbidden substring leaked: ${f}`);
        }
        const keys = Object.keys(p).join(' ').toLowerCase();
        assert.equal(keys.includes('secret'), false);
        assert.equal(keys.includes('password'), false);
        assert.equal(keys.includes('token'), false);
    });
});
