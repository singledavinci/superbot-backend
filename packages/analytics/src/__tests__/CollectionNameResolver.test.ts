import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import type { CollectionMetadata } from '../NFTMetadata';
import type { RpcPool } from '../RpcPool';
import {
    CollectionNameResolver,
    formatFallbackCollectionName,
    COLLECTION_RESOLVER_TOTAL_MS,
    type NftCollectionNameLookups,
} from '../CollectionNameResolver';

/**
 * Minimal in-memory Redis for cache-hit tests (`get`/`set`).
 */
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
    async set(k: string, v: string, _mode?: string | undefined, ttlSec?: number | string): Promise<'OK'> {
        this.store.set(k, v);
        if (typeof ttlSec === 'number' && ttlSec > 0) {
            this.ttl.set(k, Date.now() + ttlSec * 1000);
        }
        return 'OK';
    }
}

function meta(name: string | null): CollectionMetadata | null {
    if (!name) return null;
    return {
        contract: AZUKI.toLowerCase(),
        slug: null,
        name,
        imageUrl: null,
        bannerUrl: null,
        verified: null,
        totalSupply: null,
        floorPrice: null,
    };
}

const AZUKI = '0xed5af388653567af2f388e6224dc7c4b3241c544';

/** Records which provider methods fired (order / short-circuit). */
function makeLookups(hit: '' | 'os' | 'alch'): NftCollectionNameLookups & { calls: string[] } {
    const calls: string[] = [];
    const o: NftCollectionNameLookups & { calls: string[] } = {
        calls,
        fetchCollectionOpenSeaMeta: async () => {
            calls.push('os');
            return hit === 'os' ? meta('OpenSea Pets') : null;
        },
        fetchCollectionAlchemyMeta: async () => {
            calls.push('alchemy');
            return hit === 'alch' ? meta('Alchemy Pets') : null;
        },
    };
    return o;
}

/** Fake RpcPool backed by static `eth_call` for `name()`. */
function poolEncodingName(result: string): RpcPool {
    const iface = new Interface(['function name() view returns (string)']);
    const enc = iface.encodeFunctionResult('name', [result]);
    const fakeProvider = {
        call: async () => enc,
        _isProvider: true,
    };
    return {
        httpsUrls: ['http://127.0.0.1:9'],
        getHttpsProvider: () => fakeProvider as any,
        markHttpsSuccess: () => {},
    } as unknown as RpcPool;
}

test('fallback label uses Collection prefix and middle ellipsis', () => {
    const s = formatFallbackCollectionName(AZUKI);
    assert.ok(s.startsWith('Collection '), s);
    assert.ok(s.includes('…'), s);
});

test('cache hit skips OpenSea / Alchemy fetchers entirely', async () => {
    const redis = new MemKv() as any;
    await redis.set(
        `collection_name:${AZUKI}`,
        JSON.stringify({ name: 'Cached Only', source: 'opensea' }),
        'EX',
        3600,
    );
    const lookups = makeLookups('');
    const r = await new CollectionNameResolver({
        redis,
        nftMetadata: lookups,
        rpcPool: null,
    }).resolve(AZUKI);
    assert.equal(r.name, 'Cached Only');
    assert.equal(r.source, 'opensea');
    assert.deepEqual(lookups.calls, []);
});

test('tracked hint wins before OpenSea metadata', async () => {
    const lookups = makeLookups('os');
    const r = await new CollectionNameResolver({
        redis: null,
        nftMetadata: lookups,
        rpcPool: null,
    }).resolve(AZUKI, { trackedName: 'Strong Guild Label' });

    assert.equal(r.name, 'Strong Guild Label');
    assert.equal(r.source, 'tracked');
    assert.deepEqual(lookups.calls, []);
});

test('priority: OpenSea then Alchemy (no Redis, no tracked, no Rpc)', async () => {
    const chainA = makeLookups('os');
    const a = await new CollectionNameResolver({
        redis: null,
        nftMetadata: chainA,
        rpcPool: null,
    }).resolve(AZUKI);

    assert.equal(a.source, 'opensea');
    assert.deepEqual(chainA.calls, ['os']);

    const chainB = makeLookups('alch');
    const b = await new CollectionNameResolver({
        redis: null,
        nftMetadata: chainB,
        rpcPool: null,
    }).resolve(AZUKI);
    assert.equal(b.source, 'alchemy');
    assert.deepEqual(chainB.calls, ['os', 'alchemy']);
});

test('on-chain name resolves when upstream metadata is absent', async () => {
    const lookups = makeLookups('');
    const r = await new CollectionNameResolver({
        redis: null,
        nftMetadata: lookups,
        rpcPool: poolEncodingName('On-chain Label Nine'),
    }).resolve(AZUKI);

    assert.equal(r.name, 'On-chain Label Nine');
    assert.equal(r.source, 'onchain');
});

test('overall resolve stays within global budget (+ buffer)', async () => {
    const sleepMeta: NftCollectionNameLookups = {
        fetchCollectionOpenSeaMeta: async () =>
            new Promise(() => {}) as Promise<CollectionMetadata | null>,
        fetchCollectionAlchemyMeta: async () =>
            new Promise(() => {}) as Promise<CollectionMetadata | null>,
    };

    const t0 = Date.now();
    await new CollectionNameResolver({
        redis: null,
        nftMetadata: sleepMeta,
        rpcPool: null,
    }).resolve(AZUKI);
    const dt = Date.now() - t0;
    assert.ok(dt < COLLECTION_RESOLVER_TOTAL_MS + 4500, `took ${dt}ms`);
});
