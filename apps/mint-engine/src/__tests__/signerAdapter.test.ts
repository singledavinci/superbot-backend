import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { join } from 'node:path';
import { maskEthereumAddress, SignerAdapter } from '../engine/SignerAdapter';

const MINT_SIGNER_ENV_KEYS = [
    'MINT_EXTERNAL_SIGNER_URL',
    'MINT_VAULT_SIGNER_URL',
    'MINT_LOCAL_DEV_PRIVATE_KEY',
    'MINT_SIGNER_ADDRESS',
    'MINT_ENGINE_SERVICE_SECRET',
] as const;

let envSnapshot: Partial<Record<(typeof MINT_SIGNER_ENV_KEYS)[number], string | undefined>> = {};

describe('SignerAdapter — env and status helpers', () => {
    beforeEach(() => {
        envSnapshot = {};
        for (const k of MINT_SIGNER_ENV_KEYS) {
            envSnapshot[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of MINT_SIGNER_ENV_KEYS) {
            const v = envSnapshot[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('maskEthereumAddress returns short mask for valid address', () => {
        const a = '0xabcdef0000000000000000000000000000001234';
        assert.equal(maskEthereumAddress(a), '0xabcd...1234');
    });

    it('vault URL alone does not configure signer and reports vault blocker', () => {
        process.env.MINT_VAULT_SIGNER_URL = 'https://vault.example/v1/sign';
        const s = new SignerAdapter();
        assert.equal(s.signerConfigured(), false);
        assert.equal(s.resolveMode(), 'vault-signer');
        assert.equal(s.signerBlockReason(), 'VAULT_SIGNER_NOT_IMPLEMENTED');
    });

    it('external signer requires HMAC secret', () => {
        process.env.MINT_EXTERNAL_SIGNER_URL = 'https://signer.example/mint-sign';
        process.env.MINT_SIGNER_ADDRESS = '0x' + '11'.repeat(20);
        const s = new SignerAdapter();
        assert.equal(s.signerConfigured(), false);
        assert.equal(s.signerBlockReason(), 'EXTERNAL_SIGNER_HMAC_SECRET_MISSING');
    });

    it('external signer requires MINT_SIGNER_ADDRESS', () => {
        process.env.MINT_EXTERNAL_SIGNER_URL = 'https://signer.example/mint-sign';
        process.env.MINT_ENGINE_SERVICE_SECRET = 'test-secret';
        const s = new SignerAdapter();
        assert.equal(s.signerConfigured(), false);
        assert.equal(s.signerBlockReason(), 'SIGNER_ADDRESS_NOT_CONFIGURED');
    });

    it('external signer is configured when URL, secret, and address are set', () => {
        process.env.MINT_EXTERNAL_SIGNER_URL = 'https://signer.example/mint-sign';
        process.env.MINT_ENGINE_SERVICE_SECRET = 'test-secret';
        process.env.MINT_SIGNER_ADDRESS = '0x' + '11'.repeat(20);
        const s = new SignerAdapter();
        assert.equal(s.signerConfigured(), true);
        assert.equal(s.resolveMode(), 'external-signer');
        assert.equal(s.signerBlockReason(), null);
        assert.equal(s.signerAddressMasked(), '0x1111...1111');
    });

    it('SignerAdapter source does not reference User.encryptedPrivateKey', () => {
        const p = join(__dirname, '..', 'engine', 'SignerAdapter.ts');
        const src = readFileSync(p, 'utf8');
        assert.equal(src.includes('encryptedPrivateKey'), false);
    });
});
