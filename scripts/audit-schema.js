#!/usr/bin/env node
/**
 * Compares the live Postgres schema against the columns Prisma expects,
 * so we can author a follow-up migration that adds whatever drifted away.
 *
 * Run via:
 *   railway run --service Postgres --environment production -- node scripts/audit-schema.js
 */
const { Client } = require('pg');

// Mirror of packages/database/prisma/schema.prisma — keep in sync.
const EXPECTED = {
    Guild: ['id', 'discordId', 'name', 'planTier', 'settings', 'createdAt', 'updatedAt'],
    User: [
        'id',
        'discordId',
        'walletAddress',
        'encryptedPrivateKey',
        'autoMintEnabled',
        'maxMintPrice',
        'gasBufferGwei',
        'globalPremiumStatus',
        'createdAt',
        'updatedAt',
    ],
    AlertChannel: [
        'id',
        'guildId',
        'discordChannelId',
        'name',
        'alertType',
        'mentionRoleId',
        'createdAt',
        'updatedAt',
    ],
    TrackedWallet: [
        'id',
        'guildId',
        'address',
        'label',
        'alertChannelId',
        'mentionRoleId',
        'smartMoneyScore',
        'winRate',
        'totalFlips',
        'createdAt',
        'updatedAt',
    ],
    TrackedCollection: [
        'id',
        'guildId',
        'contractAddress',
        'name',
        'chain',
        'floorAlertPct',
        'floorRiseAlertPct',
        'sweepThresholdNative',
        'massListingThreshold',
        'alertChannelId',
        'mentionRoleId',
        'createdAt',
        'updatedAt',
    ],
    Watchlist: ['id', 'userId', 'targetType', 'targetAddress', 'createdAt'],
    SyncState: ['chain', 'lastBlock', 'updatedAt'],
    AlertDeliveryLog: ['id', 'deliveryKey', 'eventId', 'channelId', 'alertType', 'status', 'error', 'createdAt'],
};

(async () => {
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    if (!url) {
        console.error('No DATABASE_URL/DATABASE_PUBLIC_URL set.');
        process.exit(1);
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
        for (const [table, expectedCols] of Object.entries(EXPECTED)) {
            const { rows: tblRows } = await client.query(
                `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
                [table],
            );
            if (tblRows.length === 0) {
                console.log(`[MISSING TABLE] ${table}`);
                continue;
            }
            const { rows } = await client.query(
                `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
                [table],
            );
            const have = new Set(rows.map(r => r.column_name));
            const missing = expectedCols.filter(c => !have.has(c));
            if (missing.length === 0) {
                console.log(`[OK]      ${table}  (${rows.length} cols)`);
            } else {
                console.log(`[DRIFT]   ${table}  missing: ${missing.join(', ')}`);
            }
        }
    } finally {
        await client.end();
    }
})();
