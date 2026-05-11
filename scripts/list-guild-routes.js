// Quick sanity reader: prints all AlertChannel routes for a Discord guild.
// Usage: PRIMARY_GUILD_DISCORD_ID=... node scripts/list-guild-routes.js
const { Client } = require('pg');

(async () => {
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const gid = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';
    const c = new Client({ connectionString: url });
    await c.connect();
    const r = await c.query(
        `SELECT ac."alertType", ac."discordChannelId"
         FROM "AlertChannel" ac
         JOIN "Guild" g ON g.id = ac."guildId"
         WHERE g."discordId" = $1
         ORDER BY ac."alertType"`,
        [gid],
    );
    if (r.rows.length === 0) {
        console.log('(no routes)');
    } else {
        for (const row of r.rows) {
            console.log(row.alertType.padEnd(28) + ' -> ' + row.discordChannelId);
        }
    }
    await c.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
