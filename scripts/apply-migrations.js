#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Lightweight migration runner.
 *
 * - Walks `packages/database/prisma/migrations/<name>/migration.sql`.
 * - Tracks applied migrations in a tiny `_superbot_migrations` table so
 *   each migration only runs once even though the SQL itself is idempotent.
 * - Reads DATABASE_URL from the environment (e.g. injected by `railway run`).
 *
 * Usage:
 *   railway run -s superbot-backend -- node scripts/apply-migrations.js
 *   # or, with DATABASE_URL set locally:
 *   node scripts/apply-migrations.js
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'packages', 'database', 'prisma', 'migrations');

function listMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs
        .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
        .map(name => ({
            name,
            sqlPath: path.join(MIGRATIONS_DIR, name, 'migration.sql'),
        }))
        .filter(m => fs.existsSync(m.sqlPath));
}

async function main() {
    // Prefer the public proxy URL when running outside the Railway private network
    // (e.g. locally via `railway run`). Inside Railway containers, fall back to DATABASE_URL.
    const databaseUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.error('DATABASE_URL/DATABASE_PUBLIC_URL is not set. Run via `railway run -s <service> -- node scripts/apply-migrations.js`.');
        process.exit(1);
    }
    const usingPublic = !!process.env.DATABASE_PUBLIC_URL;
    console.log(`Using ${usingPublic ? 'DATABASE_PUBLIC_URL' : 'DATABASE_URL'} for migrations.`);

    const migrations = listMigrations();
    if (migrations.length === 0) {
        console.log('No migrations found.');
        return;
    }

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS "_superbot_migrations" (
                "name"      TEXT PRIMARY KEY,
                "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);

        const { rows: appliedRows } = await client.query('SELECT "name" FROM "_superbot_migrations"');
        const applied = new Set(appliedRows.map(r => r.name));

        for (const m of migrations) {
            if (applied.has(m.name)) {
                console.log(`= ${m.name} (already applied, skipping)`);
                continue;
            }

            const sql = fs.readFileSync(m.sqlPath, 'utf8');
            console.log(`+ ${m.name} -> applying ${sql.length} bytes of SQL`);
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO "_superbot_migrations" ("name") VALUES ($1)', [m.name]);
                await client.query('COMMIT');
                console.log(`✓ ${m.name} applied`);
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        }

        console.log('All migrations processed.');
    } finally {
        await client.end();
    }
}

main().catch(err => {
    console.error('Migration run failed:', err);
    process.exit(1);
});
