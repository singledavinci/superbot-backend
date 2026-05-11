/**
 * One-off: start mint-engine locally using Railway-exported JSON variable dumps.
 *
 * **Security:** If you ever exported Railway variables to JSON, delete those files,
 * rotate ALL exposed credentials (Discord tokens, DATABASE_URL, Redis, RPC URLs,
 * OpenSea, JWT, ClickHouse, MINT_ENGINE_SERVICE_SECRET, etc.), and prefer env vars
 * or Railway secrets — never commit dumps.
 *
 * Prefer instead: set DATABASE_URL / REDIS_URL / RPC / OPENSEA / MINT_ENGINE_SERVICE_SECRET
 * in a local `.env`, run `npm run db:migrate`, `npm run seed:mint-smoke`, then
 * `npm run smoke:mint-preflight` (see docs/mint-smoke-production.md).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readJson(p) {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return JSON.parse(s);
}

function firstHttpsRpc(backend) {
    const list = backend.HTTPS_RPC_URLS?.split(',')?.map(s => s.trim())?.filter(Boolean) ?? [];
    if (list[0]) return list[0];
    const wss = backend.WSS_RPC_URL || backend.WSS_RPC_URLS?.split(',')?.[0]?.trim();
    if (wss && wss.startsWith('wss://')) return wss.replace(/^wss:\/\//, 'https://');
    return '';
}

async function waitForHealth(url, ms = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch {
            /* retry */
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('mint-engine health timeout');
}

async function querySmokeIds(databaseUrl) {
    const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const exists = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'MintWallet'
      ) AS ok
    `);
        if (!exists.rows[0]?.ok) {
            throw new Error(
                'Database has no MintWallet table. Apply mint migrations to this DATABASE_URL (e.g. prisma migrate deploy from packages/database), then seed Guild, User, and MintWallet before smoke.',
            );
        }
        const walletQ = await client.query(`
      SELECT mw.address, mw."chainId", u."discordId" AS "userDiscordId",
             (SELECT "discordId" FROM "Guild" LIMIT 1) AS "guildDiscordId"
      FROM "MintWallet" mw
      JOIN "User" u ON u.id = mw."userId"
      LIMIT 1
    `);
        if (!walletQ.rows[0]) throw new Error('No MintWallet+User rows in DB');
        const dropQ = await client.query(`
      SELECT "collectionAddress", "chainId" FROM "MintDrop" WHERE "chainId" = $1 LIMIT 1
    `, [walletQ.rows[0].chainId]);
        const contract =
            dropQ.rows[0]?.collectionAddress ||
            process.env.SMOKE_CONTRACT_OVERRIDE ||
            null;
        if (!contract) throw new Error('No MintDrop row and no SMOKE_CONTRACT_OVERRIDE');
        return {
            guildDiscordId: String(walletQ.rows[0].guildDiscordId),
            userDiscordId: String(walletQ.rows[0].userDiscordId),
            wallet: String(walletQ.rows[0].address),
            chainId: Number(walletQ.rows[0].chainId),
            contract: String(contract).toLowerCase(),
        };
    } finally {
        await client.end();
    }
}

async function main() {
    const [backendPath, indexerPath, redisPath] = process.argv.slice(2);
    if (!backendPath || !indexerPath || !redisPath) {
        console.error('Usage: node scripts/run-local-mint-smoke-from-railway-json.mjs <backend.json> <market-indexer.json> <redis.json>');
        process.exit(2);
    }
    const backend = readJson(backendPath);
    const indexer = readJson(indexerPath);
    const redis = readJson(redisPath);

    const databaseUrl = backend.DATABASE_PUBLIC_URL || backend.DATABASE_URL;
    const redisUrl = redis.REDIS_PUBLIC_URL || redis.REDIS_URL;
    const rpcUrl = firstHttpsRpc(backend);
    const opensea = indexer.OPENSEA_API_KEY;
    if (!databaseUrl) throw new Error('DATABASE_PUBLIC_URL / DATABASE_URL missing');
    if (!redisUrl) throw new Error('REDIS_PUBLIC_URL / REDIS_URL missing');
    if (!rpcUrl) throw new Error('Could not derive HTTPS RPC from backend vars');
    if (!opensea) throw new Error('OPENSEA_API_KEY missing in indexer json');

    const smokeSecret = process.env.MINT_ENGINE_SERVICE_SECRET || `local-smoke-${Date.now()}`;
    const ids = await querySmokeIds(databaseUrl);

    const engineEnv = {
        ...process.env,
        SERVICE_TYPE: 'mint-engine',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        MINT_ENGINE_PORT: '3847',
        MINT_ENGINE_RPC_URL: rpcUrl,
        OPENSEA_API_KEY: opensea,
        MINT_ENGINE_SERVICE_SECRET: smokeSecret,
        MINT_EXECUTION_ENABLED: 'false',
        MINT_ENGINE_MODE: 'prepare',
        MINT_MAINNET_BROADCAST_ENABLED: 'false',
        MINT_TESTNET_ONLY: 'false',
        MINT_EMERGENCY_STOP: 'false',
    };

    const engine = spawn(process.execPath, [path.join(repoRoot, 'dist', 'src', 'index.js')], {
        cwd: repoRoot,
        env: engineEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    engine.stderr.on('data', d => process.stderr.write(d));
    engine.stdout.on('data', d => process.stdout.write(d));

    try {
        await waitForHealth('http://127.0.0.1:3847/health/mint-engine');
        const smoke = spawn(
            process.execPath,
            [
                '--require',
                'ts-node/register/transpile-only',
                path.join(repoRoot, 'scripts', 'smoke-mint-preflight.ts'),
                '--contract',
                ids.contract,
                '--wallet',
                ids.wallet,
                '--quantity',
                '1',
                '--mode',
                'prepare',
                '--chain-id',
                String(ids.chainId),
                '--guild',
                ids.guildDiscordId,
                '--user',
                ids.userDiscordId,
            ],
            {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    MINT_ENGINE_URL: 'http://127.0.0.1:3847',
                    MINT_ENGINE_SERVICE_SECRET: smokeSecret,
                },
                stdio: 'inherit',
            },
        );
        await new Promise((resolve, reject) => {
            smoke.on('exit', (code, sig) => {
                if (code === 0) resolve();
                else reject(new Error(`smoke exit ${code} ${sig || ''}`));
            });
            smoke.on('error', reject);
        });
    } finally {
        engine.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1500));
        try {
            engine.kill('SIGKILL');
        } catch {
            /* ignore */
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
