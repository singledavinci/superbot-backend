import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WalletActionBatcher,
    buildWalletActionBatchBase,
    deterministicWalletBatchEventId,
    parseStoredWhaleBatchEvents,
    type WhaleActionBatchStoredEvent,
    whaleBatchListKey,
    whaleBatchMetaKey,
} from '../WalletActionBatcher';

function tx(i: number): string {
    return `0x${String(i).padStart(64, '0').slice(-64)}`;
}

/** Minimal Redis mock backing lists + HASH meta + EVAL drain */
class MockRedis {
    lists = new Map<string, string[]>();
    meta = new Map<string, Record<string, string>>();
    ttl = new Map<string, number>();
    expiredKeys = new Set<string>();

    private async touch(_k: string) {
        /* no-op TTL enforcement in minimal mock */
    }

    async rpush(key: string, ...vals: string[]): Promise<number> {
        await this.touch(key);
        const cur = this.lists.get(key) ?? [];
        cur.push(...vals);
        this.lists.set(key, cur);
        return cur.length;
    }

    async llen(key: string): Promise<number> {
        return (this.lists.get(key) ?? []).length;
    }

    async hsetnx(key: string, field: string, value: string): Promise<number> {
        const row = this.meta.get(key) ?? {};
        if (row[field] !== undefined) return 0;
        row[field] = value;
        this.meta.set(key, row);
        return 1;
    }

    async hset(key: string, field: string, value: string): Promise<number> {
        const row = this.meta.get(key) ?? {};
        row[field] = value;
        this.meta.set(key, row);
        return 1;
    }

    async expire(key: string, sec: number): Promise<number> {
        this.ttl.set(key, sec);
        return 1;
    }

    async eval(_script: string, _numKeys: number, k1: string, k2: string): Promise<unknown> {
        const raw = [...(this.lists.get(k1) ?? [])];
        this.lists.delete(k1);
        this.meta.delete(k2);
        return raw;
    }
}

class MockQueue {
    adds: Array<{ name: string; data: unknown; opts?: Record<string, unknown> }> = [];
    shouldThrow = false;
    async add(
        name: string,
        data: unknown,
        opts?: Record<string, unknown>,
    ): Promise<{ id: string }> {
        if (this.shouldThrow) throw new Error('queue down');
        this.adds.push({ name, data, opts });
        return { id: 'mock' };
    }
}

function dummyEvent(n: number): WhaleActionBatchStoredEvent {
    return {
        version: 1,
        discordPayload: {
            eventId: `ev-${n}`,
            channelId: 'ch',
            trackedWalletDbId: 'wid',
            chain: 'ethereum',
        },
        whaleMetricsJson: { behavior: 'buy' },
        focalWalletLc: '0xwallet',
        firstSeenAtCandidate: n * 1000,
        enqueuedAtMs: n * 1000 + 10,
        priceNative: 0.01 * n,
        blockNumber: 18_000_000 + n,
        txHash: tx(n),
        tokenId: String(n),
    };
}

test('deterministicWalletBatchEventId is stable inside a 60s minute bucket', () => {
    const a = deterministicWalletBatchEventId({
        chainLc: 'ethereum',
        contractLc: '0xabc',
        walletLc: '0xdead',
        behavior: 'mint',
        firstSeenAtMs: 171_534_049_231,
    });
    const b = deterministicWalletBatchEventId({
        chainLc: 'ethereum',
        contractLc: '0xabc',
        walletLc: '0xdead',
        behavior: 'mint',
        firstSeenAtMs: 171_534_049_500,
    });
    assert.equal(a, b);
    assert.ok(a.includes('wallet_batch:ethereum'));
});

test('single enqueue schedules one delayed BullMQ flush job per batch base', async () => {
    const redis = new MockRedis() as unknown as import('ioredis').default;
    const mq = new MockQueue();
    const flushCalls: string[] = [];
    const batcher = new WalletActionBatcher(redis as any, mq as any, {
        enabled: true,
        flushMs: 90_000,
        maxItems: 100,
        onFlushBatch: b => flushCalls.push(b),
    });

    const base = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0xc1',
        guildDbId: 'g1',
        walletLc: '0xw1',
        behavior: 'buy',
    });
    assert.equal(await batcher.enqueue(dummyEvent(1), base), 'batched');
    assert.equal(await batcher.enqueue(dummyEvent(2), base), 'batched');

    assert.equal(mq.adds.length, 1);
    assert.equal(mq.adds[0].name, 'wallet_action_batch_flush');
    assert.equal((mq.adds[0].data as { batchBase: string }).batchBase, base);
    assert.equal(mq.adds[0].opts?.delay, 90_000);
    assert.ok(typeof mq.adds[0].opts?.jobId === 'string');

    assert.equal(flushCalls.length, 0);
});

test('overflow maxItems fires onFlushBatch without requiring delayed job on last item', async () => {
    const redis = new MockRedis() as unknown as import('ioredis').default;
    const mq = new MockQueue();
    const flushCalls: string[] = [];

    const batcher = new WalletActionBatcher(redis as any, mq as any, {
        enabled: true,
        flushMs: 90_000,
        maxItems: 3,
        onFlushBatch: b => flushCalls.push(b),
    });

    const base = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0xc2',
        guildDbId: 'g2',
        walletLc: '0xw2',
        behavior: 'sale',
    });
    await batcher.enqueue(dummyEvent(10), base);
    await batcher.enqueue(dummyEvent(11), base);
    assert.equal(mq.adds.length, 1);

    await batcher.enqueue(dummyEvent(12), base);
    assert.equal(flushCalls.length, 1);
    assert.equal(flushCalls[0], base);
});

test('distinct batch bases isolate Redis keys and schedules', async () => {
    const redis = new MockRedis();
    const mq = new MockQueue();
    const batcher = new WalletActionBatcher(redis as any, mq as any, {
        enabled: true,
        flushMs: 50_000,
        maxItems: 100,
        onFlushBatch: () => {},
    });

    const a = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0xa',
        guildDbId: 'g',
        walletLc: '0x1',
        behavior: 'buy',
    });
    const b = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0xb',
        guildDbId: 'g',
        walletLc: '0x1',
        behavior: 'buy',
    });
    await batcher.enqueue(dummyEvent(1), a);
    await batcher.enqueue(dummyEvent(2), b);
    assert.equal(mq.adds.length, 2);
    assert.notDeepEqual(
        (mq.adds[0].data as { batchBase: string }).batchBase,
        (mq.adds[1].data as { batchBase: string }).batchBase,
    );
});

test('flushJobId deterministic for stable BullMQ dedupe', () => {
    const base = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0xc99',
        guildDbId: 'guild',
        walletLc: '0xw',
        behavior: 'mint',
    });
    const id = WalletActionBatcher.flushJobId(base);
    const same = WalletActionBatcher.flushJobId(base);
    assert.equal(id, same);
});

test('drain clears list + meta and parseStoredWhaleBatchEvents round-trips', async () => {
    const mr = new MockRedis();
    const redis = mr as unknown as import('ioredis').default;
    const mq = new MockQueue();
    const batcher = new WalletActionBatcher(redis as any, mq as any, {
        enabled: true,
        flushMs: 10_000,
        maxItems: 100,
        onFlushBatch: () => {},
    });

    const base = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0xcdrain',
        guildDbId: 'gdr',
        walletLc: '0xwdr',
        behavior: 'buy',
    });
    const ev = dummyEvent(99);
    await batcher.enqueue(ev, base);

    const rows = await batcher.drain(base);
    const parsed = parseStoredWhaleBatchEvents(rows as unknown);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].tokenId, ev.tokenId);
    assert.equal(mr.lists.get(whaleBatchListKey(base)), undefined);
    assert.equal(mr.meta.get(whaleBatchMetaKey(base)), undefined);
});

test('Redis failure on enqueue returns immediate_fallback without scheduling', async () => {
    const badRedis = {
        async rpush() {
            throw new Error('redis unavailable');
        },
    };
    const mq = new MockQueue();
    const batcher = new WalletActionBatcher(badRedis as any, mq as any, {
        enabled: true,
        flushMs: 10_000,
        maxItems: 100,
        onFlushBatch: () => {},
    });
    const base = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0xdead',
        guildDbId: 'g',
        walletLc: '0xw',
        behavior: 'mint',
    });
    const r = await batcher.enqueue(dummyEvent(5), base);
    assert.equal(r, 'immediate_fallback');
    assert.equal(mq.adds.length, 0);
});

test('five events same batch key still produce one scheduler job until flush drains', async () => {
    const redis = new MockRedis() as unknown as import('ioredis').default;
    const mq = new MockQueue();
    let flushCount = 0;
    const batcher = new WalletActionBatcher(redis as any, mq as any, {
        enabled: true,
        flushMs: 60_000,
        maxItems: 100,
        onFlushBatch: async b => {
            flushCount++;
            const rows = await batcher.drain(b);
            parseStoredWhaleBatchEvents(rows as unknown);
        },
    });
    const base = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0x5',
        guildDbId: 'g',
        walletLc: '0xw',
        behavior: 'mint',
    });
    for (let i = 0; i < 5; i++) {
        await batcher.enqueue(dummyEvent(i + 1), base);
    }
    assert.equal(mq.adds.length, 1);
    assert.equal(flushCount, 0);
});

test('enqueue schedule failure invokes onFlushBatch but still counts as batched (not swallowed)', async () => {
    const redis = new MockRedis() as unknown as import('ioredis').default;
    const mq = new MockQueue();
    mq.shouldThrow = true;
    const flushed: string[] = [];
    const batcher = new WalletActionBatcher(redis as any, mq as any, {
        enabled: true,
        flushMs: 10_000,
        maxItems: 100,
        onFlushBatch: b => flushed.push(b),
    });
    const base = buildWalletActionBatchBase({
        chainLc: 'ethereum',
        contractLc: '0xschfail',
        guildDbId: 'g',
        walletLc: '0xw',
        behavior: 'buy',
    });
    const r = await batcher.enqueue(dummyEvent(42), base);
    assert.equal(r, 'batched');
    assert.equal(flushed.length, 1);
});
