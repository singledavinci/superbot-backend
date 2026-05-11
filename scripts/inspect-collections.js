// Dumps every per-collection channel override for the active guild.
const { Client } = require('pg');

(async () => {
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const gid = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';
    const c = new Client({ connectionString: url });
    await c.connect();
    const colsQ = await c.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'TrackedCollection' AND column_name LIKE '%ChannelId'`,
    );
    const cols = colsQ.rows.map((r) => r.column_name);
    console.log(`Channel-id columns on TrackedCollection: ${cols.join(', ')}`);
    const sel = cols.map((col) => `"${col}"`).join(', ');
    const r = await c.query(
        `SELECT tc.id, tc.name, tc."contractAddress", ${sel}
         FROM "TrackedCollection" tc
         JOIN "Guild" g ON g.id = tc."guildId"
         WHERE g."discordId" = $1`,
        [gid],
    );
    for (const row of r.rows) {
        console.log(`\n${row.name} (${row.contractAddress})`);
        for (const k of cols) console.log(`  ${k.padEnd(22)} ${row[k] ?? '(null)'}`);
    }
    await c.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
