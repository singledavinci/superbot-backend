#!/usr/bin/env node
/* eslint-disable no-console */
const { Client } = require('pg');

async function main() {
    const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    if (!url) {
        console.error('No DATABASE_URL/DATABASE_PUBLIC_URL set');
        process.exit(1);
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
        const { rows } = await client.query(`
            SELECT table_name
              FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_name IN ('AlertDeliveryLog', '_superbot_migrations', 'Guild', 'TrackedWallet', 'TrackedCollection')
             ORDER BY table_name
        `);
        console.log('Tables:', rows.map(r => r.table_name));
        const m = await client.query('SELECT "name", "appliedAt" FROM "_superbot_migrations" ORDER BY "appliedAt"');
        console.log('Applied migrations:');
        for (const r of m.rows) console.log(` - ${r.name} @ ${r.appliedAt.toISOString()}`);
    } finally {
        await client.end();
    }
}
main().catch(err => { console.error(err); process.exit(1); });
