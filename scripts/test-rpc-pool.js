/**
 * Smoke test: 30 parallel getBlockNumber() calls via HTTPS RPC pool; verify round-robin spread.
 *
 * Usage (from repo root, after npm run build):
 *   node scripts/test-rpc-pool.js
 *   railway run --service superbot-backend --environment production -- node scripts/test-rpc-pool.js
 */
'use strict';

require('dotenv/config');
const path = require('path');

function loadCompiledRpcPool() {
    const base = path.join(__dirname, '..', 'dist', 'packages', 'analytics', 'src', 'RpcPool');
    try {
        return require(base);
    } catch {
        console.error('[test-rpc-pool] Missing compiled RpcPool — run npm run build from repo root.');
        process.exit(1);
    }
}

const { createRpcPoolFromEnv, HTTPS_RPC_JSON_TIMEOUT_MS } = loadCompiledRpcPool();

async function timedGetBlockNumber(provider) {
    return await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, rej) =>
            setTimeout(
                () => rej(new Error('getBlockNumber timeout')),
                Math.min(HTTPS_RPC_JSON_TIMEOUT_MS || 25000, 30000),
            ),
        ),
    ]);
}

async function main() {
    const pool = createRpcPoolFromEnv();
    if (!pool || pool.httpsUrls.length === 0) {
        console.error('[test-rpc-pool] No HTTPS URLs in pool (set HTTPS_RPC_URLS / HTTPS_RPC_URL / WSS_RPC_URL).');
        process.exit(1);
    }

    const countsByLabel = new Map();
    const failures = [];

    await Promise.all(
        Array.from({ length: 30 }, async (_, i) => {
            const provider = pool.getHttpsProvider();
            const label = pool.httpsLabel(provider);
            try {
                const n = await timedGetBlockNumber(provider);
                pool.markHttpsSuccess(provider);
                countsByLabel.set(label, (countsByLabel.get(label) || 0) + 1);
                if ((i + 1) % 10 === 0) {
                    process.stdout.write('.');
                }
            } catch (e) {
                failures.push({ label, msg: String(e && e.message ? e.message : e) });
            }
        }),
    );

    console.log('');
    console.log(JSON.stringify(Object.fromEntries([...countsByLabel.entries()].sort()), null, 2));
    const total = [...countsByLabel.values()].reduce((a, b) => a + b, 0);
    const avg = countsByLabel.size ? total / countsByLabel.size : 0;
    const spreads = [...countsByLabel.values()].map(c => Math.abs(c - avg));
    const maxSpread = spreads.length ? Math.max(...spreads) : 0;

    console.log('[test-rpc-pool] completed', { totalHits: total, endpoints: countsByLabel.size, maxDeviationFromAvg: Number(maxSpread.toFixed(2)) });
    if (failures.length) {
        console.log('[test-rpc-pool] failures (label + message):', failures);
        process.exit(1);
    }
    const expectedRough = countsByLabel.size ? 30 / countsByLabel.size : 0;
    if (countsByLabel.size >= 2 && maxSpread > Math.max(6, Math.ceil(expectedRough * 2))) {
        console.warn('[test-rpc-pool] WARN: workload not evenly balanced — investigate pool sizing or blacklists.');
    }
}

main().catch(e => {
    console.error('[test-rpc-pool]', e);
    process.exit(1);
});
