#!/usr/bin/env node
/**
 * Idempotent: repair `TrackedCollection.name` when null, empty, Unknown, or raw 0x placeholder.
 *
 *   node scripts/backfill-collection-names.js
 *
 * Railway (example):
 *   railway run --service Postgres --environment production -- node scripts/backfill-collection-names.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'CommonJS' },
});

const { prisma } = require('../packages/database/src');
const { redisConnection } = require('../packages/queue/src');
const {
    NFTMetadataClient,
    CollectionNameResolver,
    createRpcPoolFromEnv,
    isPlaceholderCollectionName,
} = require('../packages/analytics/src');

(async () => {
    const pool = createRpcPoolFromEnv();
    const resolver = new CollectionNameResolver({
        redis: redisConnection,
        nftMetadata: new NFTMetadataClient({ redis: redisConnection }),
        rpcPool: pool && pool.httpsUrls.length > 0 ? pool : null,
    });

    const rows = await prisma.trackedCollection.findMany();
    let updated = 0;
    let skippedStrong = 0;
    let skippedNonEth = 0;
    const fallbacks = [];

    for (const row of rows) {
        const chainLc = (row.chain || 'ethereum').toLowerCase();
        if (chainLc !== 'ethereum') {
            skippedNonEth++;
            console.log(`[Backfill] skip non-ethereum row=${row.id} chain=${row.chain}`);
            continue;
        }

        const needs =
            !row.name || !String(row.name).trim() || isPlaceholderCollectionName(row.name);
        if (!needs) {
            skippedStrong++;
            continue;
        }

        const resolved = await resolver.resolve(row.contractAddress.toLowerCase(), {
            trackedName: row.name ?? undefined,
        });
        const next = resolved.name.slice(0, 256);
        if ((row.name ?? '') === next) {
            skippedStrong++;
            continue;
        }

        await prisma.trackedCollection.update({
            where: { id: row.id },
            data: { name: next },
        });
        updated++;
        if (resolved.source === 'fallback') {
            fallbacks.push(row.contractAddress.toLowerCase());
        }
    }

    console.log(
        `[Backfill] done. updated=${updated} skipped_already_strong_or_unchanged=${skippedStrong} skipped_non_ethereum=${skippedNonEth} scanned=${rows.length}`,
    );
    if (fallbacks.length) {
        console.log(`[Backfill] contracts_that_used_fallback=${fallbacks.length}: ${fallbacks.join(', ')}`);
    }

    await prisma.$disconnect();
    try {
        redisConnection.disconnect();
    } catch {
        /* ignore */
    }
    process.exit(0);
})().catch(err => {
    console.error('[Backfill] fatal:', err);
    process.exit(1);
});
