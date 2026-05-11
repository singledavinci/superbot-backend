import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertMainnetBroadcastAllowed } from '../engine/mainnetGuard';
import { mintEnv } from '../config/mintEnv';

describe('Live execution — mainnet guard', () => {
    it('Sepolia chain id does not throw', () => {
        assert.doesNotThrow(() => assertMainnetBroadcastAllowed(11155111));
    });

    it('mainnet throws when broadcast disabled or testnet-only', () => {
        if (!mintEnv.MINT_MAINNET_BROADCAST_ENABLED || mintEnv.MINT_TESTNET_ONLY) {
            assert.throws(() => assertMainnetBroadcastAllowed(1), /MAINNET_DISABLED/);
        }
    });
});

describe('Live execution — no legacy User key', () => {
    it('MintExecutionEngine module does not reference User.encryptedPrivateKey', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = path.join(__dirname, '..');
        const files = ['MintExecutionEngine.ts', 'SignerAdapter.ts', 'NonceManager.ts', 'BroadcastEngine.ts'].map((f) =>
            fs.readFileSync(path.join(dir, 'engine', f), 'utf8'),
        );
        const joined = files.join('\n');
        assert.equal(joined.includes('encryptedPrivateKey'), false);
    });
});
