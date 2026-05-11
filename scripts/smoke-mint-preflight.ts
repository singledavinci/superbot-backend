/**
 * End-to-end smoke: mint-engine /v1/mint/preflight (+ optional MintJob + persist).
 *
 * Required env:
 *   MINT_ENGINE_SERVICE_SECRET
 *   MINT_ENGINE_URL (default http://127.0.0.1:3847)
 *   MINT_ENGINE_RPC_URL (validated server-side; must be set on mint-engine host)
 *   OPENSEA_API_KEY (on mint-engine host for SeaDrop resolver)
 *
 * For job persistence (planHash, MintSimulation, metadata):
 *   SMOKE_GUILD_DISCORD_ID, SMOKE_USER_DISCORD_ID — must match an existing Guild/User with MintWallet for --wallet.
 *
 * Usage:
 *   node --require ts-node/register/transpile-only scripts/smoke-mint-preflight.ts \
 *     --contract 0x... --wallet 0x... --quantity 1 --mode prepare \
 *     --chain-id 1
 *
 *   npm run smoke:mint-preflight -- --contract 0x... --wallet 0x... --mode prepare
 */

import * as dotenv from 'dotenv';
import { createHash, createHmac, randomBytes } from 'crypto';

dotenv.config();

function sha256Hex(body: string): string {
    return createHash('sha256').update(body, 'utf8').digest('hex');
}

function signRequest(args: { secret: string; method: string; path: string; timestampSec: number; nonce: string; body: string }): string {
    const msg =
        args.method.toUpperCase() +
        '\n' +
        args.path +
        '\n' +
        String(args.timestampSec) +
        '\n' +
        args.nonce +
        '\n' +
        sha256Hex(args.body);
    return createHmac('sha256', args.secret).update(msg, 'utf8').digest('hex');
}

function arg(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(name);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    return def;
}

function hasFlag(name: string): boolean {
    return process.argv.includes(name);
}

async function postMint(
    path: string,
    jsonBody: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown>; meta: { fullPath: string; body: string; sig: string; ts: number; nonce: string } }> {
    const base = (process.env.MINT_ENGINE_URL || 'http://127.0.0.1:3847').replace(/\/+$/, '');
    const fullPath = `/v1/mint${path}`;
    const url = `${base}${fullPath}`;
    const secret = (process.env.MINT_ENGINE_SERVICE_SECRET || '').replace(/^\uFEFF/, '').trim();
    if (!secret) throw new Error('MINT_ENGINE_SERVICE_SECRET is not set');
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString('hex');
    const body = JSON.stringify(jsonBody);
    const sig = signRequest({ secret, method: 'POST', path: fullPath, timestampSec: ts, nonce, body });
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-SUPERBOT-SERVICE': 'smoke-mint-preflight',
            'X-SUPERBOT-TIMESTAMP': String(ts),
            'X-SUPERBOT-NONCE': nonce,
            'X-SUPERBOT-SIGNATURE': sig,
        },
        body,
    });
    const j = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json: j, meta: { fullPath, body, sig, ts, nonce } };
}

async function main(): Promise<void> {
    const contract = arg('--contract');
    const wallet = arg('--wallet');
    const quantity = Math.max(1, Number(arg('--quantity', '1')));
    const mode = (arg('--mode', 'prepare') as string).toLowerCase();
    const chainId = Number(arg('--chain-id', String(process.env.SMOKE_CHAIN_ID || '1')));
    const guildDiscordId = arg('--guild', process.env.SMOKE_GUILD_DISCORD_ID);
    const userDiscordId = arg('--user', process.env.SMOKE_USER_DISCORD_ID);
    const skipJob = hasFlag('--skip-job');

    if (!contract || !wallet) {
        console.error(
            'Usage: --contract <0x…> --wallet <0x…> [--quantity 1] [--mode prepare|simulation] [--chain-id 1] [--guild …] [--user …] [--skip-job]',
        );
        process.exit(2);
    }

    if (mode !== 'prepare' && mode !== 'simulation') {
        console.error('--mode must be prepare or simulation');
        process.exit(2);
    }

    if (!guildDiscordId || !userDiscordId) {
        console.error('Set SMOKE_GUILD_DISCORD_ID and SMOKE_USER_DISCORD_ID (or pass --guild / --user) to match DB records for preflight.');
        process.exit(2);
    }

    let jobId: string | null = null;
    if (!skipJob) {
        const jobPayload: Record<string, unknown> = {
            guildDiscordId,
            userDiscordId,
            walletAddress: wallet,
            collectionAddress: contract,
            mintContract: contract,
            dropSource: 'opensea',
            dropType: 'unknown',
            triggerType: 'SMOKE_PREFLIGHT',
            executionMode: mode,
            chainId,
            quantity,
        };
        const jobRes = await postMint('/jobs', jobPayload);
        console.log('POST /jobs HTTP', jobRes.status);
        if (jobRes.json.error) {
            console.log(JSON.stringify(jobRes.json, null, 2));
            if (jobRes.json.error === 'BAD_SIGNATURE') {
                const sec = (process.env.MINT_ENGINE_SERVICE_SECRET || '').replace(/^\uFEFF/, '').trim();
                console.error('[smoke] client HMAC debug:', {
                    signPath: jobRes.meta.fullPath,
                    bodySha256: sha256Hex(jobRes.meta.body),
                    secretLen: sec.length,
                    sigPrefix: jobRes.meta.sig.slice(0, 10),
                    expectedSigPrefix: typeof jobRes.json.expectedSigPrefix === 'string' ? jobRes.json.expectedSigPrefix : '—',
                    hint: 'If signPath + bodySha256 + secretLen match server JSON but sig prefixes differ, secrets differ. If bodySha256 differs, body bytes differ.',
                });
            }
            console.error('Job creation failed; fix DB fixtures or use --skip-job for HTTP-only preflight.');
            process.exit(1);
        }
        jobId = String(jobRes.json.id ?? '');
        if (!jobId) {
            console.error('No job id returned');
            process.exit(1);
        }
        console.log('jobId', jobId);
    }

    const preBody: Record<string, unknown> = {
        guildDiscordId,
        userDiscordId,
        walletAddress: wallet,
        collectionAddress: contract,
        dropSource: 'opensea',
        chainId,
        quantity,
        executionMode: mode,
    };
    if (jobId) preBody.persistJobId = jobId;

    const pre = await postMint('/preflight', preBody);
    console.log('POST /preflight HTTP', pre.status);
    const j = pre.json;
    console.log(JSON.stringify(j, null, 2));

    const verified = j.verifiedDrop as Record<string, unknown> | undefined;
    const sim = j.simulation as Record<string, unknown> | undefined;

    let mintSimCreated: boolean | null = null;
    if (jobId) {
        const jr = await postMint('/jobs/result', { jobId });
        const job = jr.json.job as Record<string, unknown> | undefined;
        const sims = job?.simulations as unknown[] | undefined;
        mintSimCreated = Array.isArray(sims) && sims.length > 0;
        console.log('POST /jobs/result HTTP', jr.status, 'MintSimulation rows', sims?.length ?? 0);
    }

    const unsigned = j.unsignedPrepare as Record<string, unknown> | undefined;
    const unsignedPresent = Boolean(unsigned && Object.keys(unsigned).length > 0);

    console.log('\n--- Smoke summary ---');
    console.log('HTTP status', pre.status);
    console.log('resolverStatus', j.resolverStatus ?? '—');
    console.log('dropType', verified?.dropType ?? '—');
    console.log('mint/SeaDrop to', verified?.seaDropContract ?? verified?.mintContract ?? '—');
    console.log('priceNative', verified?.priceNative ?? '—');
    console.log('startTime', verified?.startTime ?? '—');
    console.log('endTime', verified?.endTime ?? '—');
    console.log('planHash', j.planHash ?? '—');
    console.log('simulationStatus', sim?.status ?? j.simulationStatus ?? '—');
    console.log('unsignedPrepare present', unsignedPresent);
    console.log('jobId', jobId ?? '—');
    console.log('MintSimulation row created', mintSimCreated ?? 'n/a (no job)');
    console.log('signingOccurred', j.signingOccurred ?? '—');
    console.log('broadcastOccurred', j.broadcastOccurred ?? '—');
    console.log('ok', j.ok);

    const strictOk =
        Boolean(j.ok) &&
        pre.status === 200 &&
        j.resolverStatus === 'ok' &&
        unsignedPresent &&
        (sim?.status === 'PASS' || sim?.status === 'PASS_STAGE_NOT_OPEN_YET');

    if (strictOk && jobId && mintSimCreated === true) {
        console.log('\nFINAL VERDICT: Prepare-only beta ready (smoke passed with job persistence).');
    } else if (strictOk) {
        console.log('\nFINAL VERDICT: Preflight HTTP path OK; run with DB fixtures + --guild/--user to prove MintJob/MintSimulation persistence.');
    } else {
        console.log('\nFINAL VERDICT: Phase 3 advanced, prepare-only beta not yet proven.');
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
