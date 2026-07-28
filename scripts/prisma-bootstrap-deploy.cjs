'use strict';

/**
 * Bootstrap a genuinely empty PostgreSQL database from the current Prisma
 * schema, then baseline the historical migrations. Existing Superbot databases
 * always use the normal, non-destructive `migrate deploy` path.
 *
 * The oldest migrations in this repository were created after the original
 * Railway database already contained core tables, so they cannot initialize a
 * brand-new database on their own.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
const dbDir = path.join(root, 'packages', 'database');
const schemaPath = 'prisma/schema.prisma';
const migrationsDir = path.join(dbDir, 'prisma', 'migrations');

function runPrisma(args) {
    const result = spawnSync(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['prisma', ...args],
        {
            cwd: dbDir,
            stdio: 'inherit',
            env: process.env,
            shell: process.platform === 'win32',
        },
    );
    if (result.status !== 0) {
        process.exit(result.status === null ? 1 : result.status);
    }
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required');
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const tablesResult = await client.query(
        `SELECT tablename
           FROM pg_catalog.pg_tables
          WHERE schemaname = 'public'
          ORDER BY tablename`,
    );
    await client.end();

    const tables = tablesResult.rows.map((row) => String(row.tablename));
    if (tables.includes('Guild')) {
        console.log('[db:bootstrap] Existing Superbot schema detected; running migrate deploy.');
        runPrisma(['migrate', 'deploy', `--schema=${schemaPath}`]);
        return;
    }

    const nonMigrationTables = tables.filter((name) => name !== '_prisma_migrations');
    if (nonMigrationTables.length > 0) {
        throw new Error(
            `Refusing to bootstrap a non-empty, unrecognized schema. Tables: ${nonMigrationTables.join(', ')}`,
        );
    }

    console.log('[db:bootstrap] Empty database detected; applying the current schema.');
    runPrisma(['db', 'push', `--schema=${schemaPath}`]);

    const migrations = fs
        .readdirSync(migrationsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

    for (const migration of migrations) {
        runPrisma(['migrate', 'resolve', '--applied', migration, `--schema=${schemaPath}`]);
    }

    runPrisma(['migrate', 'deploy', `--schema=${schemaPath}`]);
    console.log(`[db:bootstrap] Fresh schema baselined across ${migrations.length} migrations.`);
}

main().catch((error) => {
    console.error('[db:bootstrap] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
});
