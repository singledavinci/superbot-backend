// Inspects all Guild rows + their routing summary.
const { Client } = require('pg');

(async () => {
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const c = new Client({ connectionString: url });
    await c.connect();
    const g = await c.query(
        `SELECT id, "discordId", name, "createdAt", "updatedAt" FROM "Guild" ORDER BY "createdAt"`,
    );
    for (const row of g.rows) {
        const w = await c.query('SELECT COUNT(*)::int AS n FROM "TrackedWallet" WHERE "guildId" = $1', [row.id]);
        const col = await c.query('SELECT COUNT(*)::int AS n FROM "TrackedCollection" WHERE "guildId" = $1', [row.id]);
        const ac = await c.query('SELECT COUNT(*)::int AS n FROM "AlertChannel" WHERE "guildId" = $1', [row.id]);
        console.log(`Guild internal=${row.id}`);
        console.log(`  discordId   ${row.discordId}`);
        console.log(`  name        ${row.name}`);
        console.log(`  created     ${row.createdAt.toISOString()}`);
        console.log(`  wallets=${w.rows[0].n}  collections=${col.rows[0].n}  alertChannels=${ac.rows[0].n}`);
        const ach = await c.query(
            `SELECT "alertType", "discordChannelId" FROM "AlertChannel" WHERE "guildId" = $1 ORDER BY "alertType"`,
            [row.id],
        );
        for (const r of ach.rows) console.log(`    ${r.alertType.padEnd(26)} -> ${r.discordChannelId}`);
        console.log('');
    }
    await c.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
