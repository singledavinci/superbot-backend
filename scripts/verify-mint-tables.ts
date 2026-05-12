/**
 * Verify mint-engine tables and partial unique index after migrate deploy.
 * Requires DATABASE_URL. Does not print secrets.
 */
import 'dotenv/config';
import pg from 'pg';

const REQUIRED = [
    'MintWallet',
    'MintWalletAuthorization',
    'CopyMintConfig',
    'MintJob',
    'MintDrop',
    'NonceLock',
    'MintTransaction',
    'MintSimulation',
    'MintAuditLog',
    'TrackedMintTrigger',
    'MintProviderHealth',
    'MintMainnetReadiness',
    'MainnetExecutionApproval',
    'MintEngineRuntimeState',
];

async function main(): Promise<void> {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
        console.error('DATABASE_URL is not set');
        process.exit(2);
    }
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
        const have = await client.query(
            `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
            [REQUIRED],
        );
        const set = new Set(have.rows.map(r => r.tablename));
        let ok = true;
        for (const t of REQUIRED) {
            const present = set.has(t);
            console.log(`${present ? 'OK' : 'MISS'} ${t}`);
            if (!present) ok = false;
        }
        const idx = await client.query(
            `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'NonceLock_active_nonce_unique'`,
        );
        if (idx.rows[0]) {
            console.log('OK NonceLock_active_nonce_unique exists');
            console.log('   ', String(idx.rows[0].indexdef).slice(0, 200) + (String(idx.rows[0].indexdef).length > 200 ? '…' : ''));
        } else {
            console.log('MISS NonceLock_active_nonce_unique');
            ok = false;
        }
        process.exit(ok ? 0 : 1);
    } finally {
        await client.end();
    }
}

main().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
