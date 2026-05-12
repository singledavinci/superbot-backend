import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mintExecutorStatusEnvBlocker } from '../lib/mintStatusEnv';

describe('mintExecutorStatusEnvBlocker', () => {
    it('returns MINT_ENGINE_URL missing when URL unset', () => {
        const pu = process.env.MINT_ENGINE_URL;
        const ps = process.env.MINT_ENGINE_SERVICE_SECRET;
        delete process.env.MINT_ENGINE_URL;
        process.env.MINT_ENGINE_SERVICE_SECRET = 'test-secret-placeholder';
        try {
            assert.equal(mintExecutorStatusEnvBlocker(), 'MINT_ENGINE_URL missing');
        } finally {
            if (pu === undefined) delete process.env.MINT_ENGINE_URL;
            else process.env.MINT_ENGINE_URL = pu;
            if (ps === undefined) delete process.env.MINT_ENGINE_SERVICE_SECRET;
            else process.env.MINT_ENGINE_SERVICE_SECRET = ps;
        }
    });

    it('returns MINT_ENGINE_SERVICE_SECRET missing when secret unset', () => {
        const pu = process.env.MINT_ENGINE_URL;
        const ps = process.env.MINT_ENGINE_SERVICE_SECRET;
        process.env.MINT_ENGINE_URL = 'https://example.invalid';
        delete process.env.MINT_ENGINE_SERVICE_SECRET;
        try {
            assert.equal(mintExecutorStatusEnvBlocker(), 'MINT_ENGINE_SERVICE_SECRET missing');
        } finally {
            if (pu === undefined) delete process.env.MINT_ENGINE_URL;
            else process.env.MINT_ENGINE_URL = pu;
            if (ps === undefined) delete process.env.MINT_ENGINE_SERVICE_SECRET;
            else process.env.MINT_ENGINE_SERVICE_SECRET = ps;
        }
    });

    it('returns null when both required vars are set', () => {
        const pu = process.env.MINT_ENGINE_URL;
        const ps = process.env.MINT_ENGINE_SERVICE_SECRET;
        process.env.MINT_ENGINE_URL = 'https://example.invalid';
        process.env.MINT_ENGINE_SERVICE_SECRET = 'test-secret-placeholder';
        try {
            assert.equal(mintExecutorStatusEnvBlocker(), null);
        } finally {
            if (pu === undefined) delete process.env.MINT_ENGINE_URL;
            else process.env.MINT_ENGINE_URL = pu;
            if (ps === undefined) delete process.env.MINT_ENGINE_SERVICE_SECRET;
            else process.env.MINT_ENGINE_SERVICE_SECRET = ps;
        }
    });
});
