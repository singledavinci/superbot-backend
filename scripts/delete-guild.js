// Deletes a Guild row and any dependent rows.
// Usage: node scripts/delete-guild.js <internalGuildId>
const { Client } = require('pg');

const DEPENDENT_TABLES = [
    'AlertChannel',
    'TrackedWallet',
    'TrackedCollection',
    'Watchlist',
    'SyncState',
];

(async () => {
    const internalGuildId = process.argv[2];
    if (!internalGuildId) throw new Error('Missing internalGuildId arg');
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const c = new Client({ connectionString: url });
    await c.connect();
    // Each delete runs independently. If a dependent table doesn't exist we skip it;
    // a single transaction would abort on the first miss, so we avoid wrapping these.
    for (const table of DEPENDENT_TABLES) {
        try {
            const r = await c.query(`DELETE FROM "${table}" WHERE "guildId" = $1`, [internalGuildId]);
            if (r.rowCount > 0) console.log(`  ${table}: ${r.rowCount} row(s) deleted`);
        } catch (err) {
            if (err.code === '42P01' || err.code === '42703') {
                console.log(`  ${table}: skip (${err.code})`);
                continue;
            }
            console.error(`  ${table}: ERROR ${err.code} ${err.message}`);
        }
    }
    const g = await c.query(`DELETE FROM "Guild" WHERE id = $1 RETURNING "discordId", name`, [internalGuildId]);
    if (g.rows.length === 0) {
        console.log(`No Guild found with id ${internalGuildId}`);
    } else {
        console.log(`Guild deleted: name="${g.rows[0].name}" discordId=${g.rows[0].discordId}`);
    }
    await c.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
