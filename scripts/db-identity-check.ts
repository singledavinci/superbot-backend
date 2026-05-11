/**
 * DB identity check before mint migrations (no secrets printed).
 * Requires DATABASE_URL in environment.
 *
 * Usage: npx dotenv -e .env -- node --require ts-node/register/transpile-only scripts/db-identity-check.ts
 *    or: set DATABASE_URL=... && node --require ts-node/register/transpile-only scripts/db-identity-check.ts
 */
import 'dotenv/config';
import pg from 'pg';

async function main(): Promise<void> {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
        console.error('DATABASE_URL is not set');
        process.exit(2);
    }
    console.log('Connecting with DATABASE_URL from environment (credentials are never printed).');

    let host = '';
    try {
        host = new URL(url.replace(/^postgresql:/i, 'http:')).hostname;
    } catch {
        /* ignore */
    }
    const useSsl =
        host &&
        host !== 'localhost' &&
        host !== '127.0.0.1' &&
        process.env.DATABASE_SSL_DISABLE !== '1';
    const client = new pg.Client({
        connectionString: url,
        ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    try {
        const db = await client.query('SELECT current_database() AS db, current_user AS usr');
        console.log('current_database:', db.rows[0]?.db);
        console.log('current_user:', db.rows[0]?.usr);

        const ver = await client.query('SELECT version() AS v');
        console.log('server:', String(ver.rows[0]?.v).split('\n')[0].slice(0, 120));

        const tables = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
        console.log(`public tables: ${tables.rows.length}`);
        console.log(tables.rows.map(r => r.tablename).join(', '));

        const mig = await client.query(`
      SELECT COUNT(*)::int AS c FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    `);
        if (mig.rows[0]?.c) {
            const applied = await client.query(`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 8`);
            console.log('recent migrations:');
            for (const row of applied.rows) {
                console.log(`  - ${row.migration_name} @ ${row.finished_at}`);
            }
        } else {
            console.log('_prisma_migrations: not present (fresh DB or non-Prisma)');
        }
    } finally {
        await client.end();
    }
}

main().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
