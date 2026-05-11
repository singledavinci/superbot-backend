// Nulls per-collection channel overrides so every alert type for the guild
// resolves through the global AlertChannel routing (the layout under
// "SuperBot Alerts"). Keeps thresholds and tracked addresses intact.
const { Client } = require('pg');

(async () => {
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const gid = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';
    const c = new Client({ connectionString: url });
    await c.connect();

    const channelCols = await c.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'TrackedCollection' AND column_name LIKE '%ChannelId'`,
    );
    const cols = channelCols.rows.map((r) => r.column_name);
    console.log(`Nulling these columns on every TrackedCollection: ${cols.join(', ')}`);

    const setClause = cols.map((col) => `"${col}" = NULL`).join(', ');
    const r = await c.query(
        `UPDATE "TrackedCollection" SET ${setClause}
         WHERE "guildId" IN (SELECT id FROM "Guild" WHERE "discordId" = $1)
         RETURNING id, name`,
        [gid],
    );
    console.log(`Updated ${r.rowCount} collection(s):`);
    for (const row of r.rows) console.log(`  - ${row.name} (${row.id})`);

    await c.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
