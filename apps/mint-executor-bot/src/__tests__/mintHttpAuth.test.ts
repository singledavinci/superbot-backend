import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mintEnginePost } from '../lib/mintHttp';

describe('mintEnginePost auth', () => {
    it('throws a clear error when MINT_ENGINE_SERVICE_SECRET is not set (HMAC cannot run)', async () => {
        const prev = process.env.MINT_ENGINE_SERVICE_SECRET;
        delete process.env.MINT_ENGINE_SERVICE_SECRET;
        try {
            await assert.rejects(
                async () => mintEnginePost('/status', {}),
                (e: unknown) => e instanceof Error && e.message.includes('MINT_ENGINE_SERVICE_SECRET'),
            );
        } finally {
            if (prev === undefined) delete process.env.MINT_ENGINE_SERVICE_SECRET;
            else process.env.MINT_ENGINE_SERVICE_SECRET = prev;
        }
    });
});
