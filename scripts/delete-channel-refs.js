// Deletes every AlertChannel row pointing at a given Discord channel ID.
// Usage: node scripts/delete-channel-refs.js <channelId>
const { Client } = require('pg');

(async () => {
    const channelId = process.argv[2];
    if (!channelId) throw new Error('Missing channelId arg');
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const c = new Client({ connectionString: url });
    await c.connect();
    const r = await c.query(
        `DELETE FROM "AlertChannel" WHERE "discordChannelId" = $1 RETURNING id, "guildId", "alertType"`,
        [channelId],
    );
    console.log(`Deleted ${r.rows.length} AlertChannel row(s) referencing ${channelId}`);
    for (const row of r.rows) console.log(`  - ${row.alertType} (guildId=${row.guildId}, id=${row.id})`);
    await c.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
