const { Client } = require("pg");
(async () => {
    const cs = process.env.DATABASE_PUBLIC_URL;
    if (!cs) {
        console.error("No DATABASE_PUBLIC_URL");
        process.exit(1);
    }
    const c = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
    await c.connect();
    // AlertDeliveryLog has createdAt only (no on-chain event timestamp column).
    const { rows } = await c.query(`
    SELECT "alertType",
           COUNT(*)::int AS n,
           MAX("createdAt") AS last_delivery
    FROM "AlertDeliveryLog"
    WHERE "createdAt" > NOW() - INTERVAL '2 hours'
      AND "status" = 'delivered'
    GROUP BY "alertType"
    ORDER BY n DESC
  `);
    console.table(rows);
    await c.end();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
