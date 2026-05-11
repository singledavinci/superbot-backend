// Finds every database row that references a given Discord channel ID.
// Usage: node scripts/find-channel-refs.js <channelId>
// Reads DATABASE_PUBLIC_URL (preferred for external access) or DATABASE_URL.

const { Client } = require('pg');

async function main() {
    const channelId = process.argv[2] || '1503039737878020126';
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    if (!url) {
        console.error('Missing DATABASE_PUBLIC_URL / DATABASE_URL');
        process.exit(1);
    }
    const client = new Client({ connectionString: url });
    await client.connect();

    console.log(`\nSearching for channel ${channelId}...\n`);

    const queries = [
        {
            label: 'AlertChannel (per-alert-type routing)',
            sql: `SELECT id, "guildId", "alertType", "discordChannelId", "createdAt" FROM "AlertChannel" WHERE "discordChannelId" = $1`,
        },
        {
            label: 'TrackedCollection.alertChannelId',
            sql: `SELECT id, "guildId", "contractAddress", "name", "alertChannelId" FROM "TrackedCollection" WHERE "alertChannelId" = $1`,
        },
        {
            label: 'TrackedCollection.hotMintChannelId',
            sql: `SELECT id, "guildId", "contractAddress", "name", "hotMintChannelId" FROM "TrackedCollection" WHERE "hotMintChannelId" = $1`,
        },
        {
            label: 'TrackedCollection.mintChannelId',
            sql: `SELECT id, "guildId", "contractAddress", "name", "mintChannelId" FROM "TrackedCollection" WHERE "mintChannelId" = $1`,
        },
        {
            label: 'TrackedCollection.salesChannelId',
            sql: `SELECT id, "guildId", "contractAddress", "name", "salesChannelId" FROM "TrackedCollection" WHERE "salesChannelId" = $1`,
        },
        {
            label: 'TrackedCollection.floorChannelId',
            sql: `SELECT id, "guildId", "contractAddress", "name", "floorChannelId" FROM "TrackedCollection" WHERE "floorChannelId" = $1`,
        },
        {
            label: 'TrackedCollection.listingChannelId',
            sql: `SELECT id, "guildId", "contractAddress", "name", "listingChannelId" FROM "TrackedCollection" WHERE "listingChannelId" = $1`,
        },
        {
            label: 'TrackedWallet.alertChannelId',
            sql: `SELECT id, "guildId", "address", "label", "alertChannelId" FROM "TrackedWallet" WHERE "alertChannelId" = $1`,
        },
        {
            label: 'Guild.alertChannelId (default)',
            sql: `SELECT "discordId", "name", "alertChannelId" FROM "Guild" WHERE "alertChannelId" = $1`,
        },
    ];

    let totalRefs = 0;
    for (const { label, sql } of queries) {
        try {
            const result = await client.query(sql, [channelId]);
            if (result.rows.length > 0) {
                totalRefs += result.rows.length;
                console.log(`### ${label} — ${result.rows.length} match(es)`);
                for (const row of result.rows) console.log(JSON.stringify(row));
                console.log('');
            }
        } catch (err) {
            if (err.code === '42703') {
                // column doesn't exist — skip silently
            } else {
                console.error(`(skip) ${label}: ${err.message}`);
            }
        }
    }

    if (totalRefs === 0) {
        console.log('No references found.');
    } else {
        console.log(`Total: ${totalRefs} references to channel ${channelId}.`);
    }

    await client.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
