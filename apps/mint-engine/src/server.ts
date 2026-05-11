import express, { Router } from 'express';
import { prisma, connectDB } from '@superbot/database';
import { redisConnection } from '@superbot/queue';
import { resolveHttpRpcUrl, parseCommaSeparatedRpcUrls } from '@superbot/analytics';
import { mintEnv } from './config/mintEnv';
import { createHmacAuthMiddleware } from './http/serviceHmac';
import { registerMintRoutes, registerMetricsRoute } from './http/mintRoutes';
import { RecoveryWorker } from './engine/RecoveryWorker';
import { MempoolWatcher } from './engine/MempoolWatcher';
import { ChainEventWatcher } from './engine/ChainEventWatcher';
import { SignerAdapter } from './engine/SignerAdapter';
import { ClockSyncMonitor } from './engine/ClockSyncMonitor';
import { startMintExecutionWorkers } from './worker/mintExecutionWorker';

function resolveMintEngineRpcUrl(): string | null {
    const explicit = process.env.MINT_ENGINE_RPC_URL?.trim();
    if (explicit) return explicit;
    const fromList = parseCommaSeparatedRpcUrls(process.env.HTTPS_RPC_URLS)[0];
    if (fromList) return fromList;
    return resolveHttpRpcUrl('WSS_RPC_URL', 'HTTPS_RPC_URL');
}

export async function startMintEngineHttp(): Promise<void> {
    await connectDB();
    const rpcUrl = resolveMintEngineRpcUrl();
    const app = express();

    app.get('/health/mint-engine', (_req, res) => {
        res.json({
            ok: true,
            service: 'mint-engine',
            mode: mintEnv.MINT_ENGINE_MODE,
            executionEnabled: mintEnv.MINT_EXECUTION_ENABLED,
            emergencyStop: mintEnv.MINT_EMERGENCY_STOP,
        });
    });

    app.get('/health/mint-providers', async (_req, res) => {
        const rows = await prisma.mintProviderHealth.findMany({ take: 50 });
        res.json({ ok: true, providers: rows });
    });

    app.get('/health/mint-signer', (_req, res) => {
        const s = new SignerAdapter();
        res.json({ ok: true, signerConfigured: s.signerConfigured() });
    });

    app.get('/health/mint-clock', async (_req, res) => {
        const c = new ClockSyncMonitor(rpcUrl);
        const drift = await c.measureDriftMs();
        res.json({ ok: true, drift });
    });

    const mintRouter = Router();
    mintRouter.use(
        express.json({
            limit: '1mb',
            verify: (req, _res, buf) => {
                (req as express.Request & { rawBody: Buffer }).rawBody = buf;
            },
        }),
    );
    mintRouter.use(createHmacAuthMiddleware(redisConnection));
    registerMintRoutes(mintRouter, { prisma, redis: redisConnection, rpcUrl });
    app.use('/v1/mint', mintRouter);

    registerMetricsRoute(app);

    const recovery = new RecoveryWorker(prisma);
    const n = await recovery.reconcileOnStartup();
    console.log(`[MintEngine] Recovery touched ${n} pending job(s)`);

    new MempoolWatcher().start();
    new ChainEventWatcher().start();

    await startMintExecutionWorkers({ prisma, redis: redisConnection, rpcUrl });

    app.listen(mintEnv.MINT_ENGINE_PORT, () => {
        console.log(`[MintEngine] Listening on :${mintEnv.MINT_ENGINE_PORT}`);
    });
}
