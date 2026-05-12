import express, { Router } from 'express';
import { prisma, connectDB } from '@superbot/database';
import { redisConnection } from '@superbot/queue';
import { resolveHttpRpcUrl, parseCommaSeparatedRpcUrls } from '@superbot/analytics';
import { mintEnv } from './config/mintEnv';
import { buildMintEngineHealthPayload } from './http/mintEngineHealthPayload';
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

    app.get('/health/mint-engine', async (_req, res) => {
        try {
            const payload = await buildMintEngineHealthPayload(prisma);
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('X-Mint-Engine-Health-Schema', String(payload.healthSchemaVersion));
            res.json(payload);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.status(503).json({
                ok: false,
                service: 'mint-engine',
                error: 'health_payload_failed',
                message: msg.slice(0, 500),
            });
        }
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
