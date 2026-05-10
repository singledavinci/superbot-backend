import test from 'node:test';
import assert from 'node:assert/strict';
import type { NFTMetadata } from '../NFTMetadata';
import {
    NftNameResolver,
    canonicalNftNameRedisKey,
    NFT_NAME_RESOLVER_TOTAL_MS,
    type NftNameLookups,
} from '../NftNameResolver';

class MemKv {
    store = new Map<string, string>();
    ttl = new Map<string, number>();

    async get(k: string): Promise<string | null> {
        const exp = this.ttl.get(k);
        if (exp !== undefined && exp < Date.now()) {
            this.store.delete(k);
            this.ttl.delete(k);
        }
        return this.store.has(k) ? String(this.store.get(k)) : null;
    }

    async set(k: string, v: string, _mode?: string, ttlSec?: number | string): Promise<'OK'> {
        this.store.set(k, v);
        if (typeof ttlSec === 'number' && ttlSec > 0) {
            this.ttl.set(k, Date.now() + ttlSec * 1000);
        }
        return 'OK';
    }
}

const CONTRACT = '0xed5af388653567af2f388e6224dc7c4b3241c544';

/** Records lookup calls — OpenSea fires before Alchemy in the waterfall. */
function makeLookups(opts: {
    delayOs?: Promise<NFTMetadata | null>;
    delayAl?: Promise<NFTMetadata | null>;
}): NftNameLookups & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        fetchNFTOpenSeaOnly: async () => {
            calls.push('os');
            return opts.delayOs ?? null;
        },
        fetchNFTAlchemyOnly: async () => {
            calls.push('al');
            return opts.delayAl ?? null;
        },
    };
}

test('synthetic fallback uses `<CollectionName> #<tokenId>` when no upstream succeeds', async () => {
    const lookups = makeLookups({});
    const r = await new NftNameResolver({
        redis: null,
        nftMetadata: lookups,
        rpcPool: null,
    }).resolveNftName(CONTRACT, '8421', { collectionName: 'Pudgy Friends' });

    assert.equal(r.name, 'Pudgy Friends #8421');
    assert.equal(r.source, 'synthetic');
    assert.deepEqual(lookups.calls, ['os', 'al']);
});

test('canonical Redis hit short-circuits OpenSea / Alchemy', async () => {
    const redis = new MemKv() as any;
    await redis.set(
        canonicalNftNameRedisKey(CONTRACT.toLowerCase(), '1'),
        JSON.stringify({ name: 'Cached Pudgy Name', source: 'opensea' }),
        'EX',
        3600,
    );

    const lookups = makeLookups({});
    const r = await new NftNameResolver({
        redis,
        nftMetadata: lookups,
        rpcPool: null,
    }).resolveNftName(CONTRACT, '1', { collectionName: 'Pudgy' });

    assert.equal(r.name, 'Cached Pudgy Name');
    assert.equal(r.source, 'cache');
    assert.deepEqual(lookups.calls, []);
});

test(`never-resolving lookups still finish within ~${NFT_NAME_RESOLVER_TOTAL_MS}ms budget`, async () => {
    const hang = new Promise<NFTMetadata | null>(() => {});
    const lookups = makeLookups({ delayOs: hang, delayAl: hang });
    const t0 = Date.now();
    const r = await new NftNameResolver({
        redis: null,
        nftMetadata: lookups,
        rpcPool: null,
    }).resolveNftName(CONTRACT, '999', { collectionName: 'Bench' });

    const ms = Date.now() - t0;
    assert.ok(ms < NFT_NAME_RESOLVER_TOTAL_MS + 850, `took ${ms}ms`);
    assert.equal(r.source, 'synthetic');
    assert.equal(r.name, 'Bench #999');
    assert.deepEqual(lookups.calls, ['os', 'al']);
});
