import { describe, it } from 'node:test';
import assert from 'node:assert';
import { signServiceRequest, sha256HexBody } from '../http/serviceHmac';

describe('serviceHmac', () => {
    it('signs deterministic payload', () => {
        const secret = 'test-secret';
        const body = '{"a":1}';
        const sig = signServiceRequest({
            secret,
            method: 'POST',
            path: '/v1/mint/status',
            timestampSec: 1700000000,
            nonce: 'abc',
            body,
        });
        const again = signServiceRequest({
            secret,
            method: 'POST',
            path: '/v1/mint/status',
            timestampSec: 1700000000,
            nonce: 'abc',
            body,
        });
        assert.strictEqual(sig, again);
        assert.strictEqual(sha256HexBody(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
});
