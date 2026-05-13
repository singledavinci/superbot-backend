import type { Request, Response, Router } from 'express';
import type IORedis from 'ioredis';
import type { PrismaClient } from '@superbot/database';
import { mintExecutionQueue } from '@superbot/queue';
import { MintExecutionEngine } from '../engine/MintExecutionEngine';
import { ClockSyncMonitor } from '../engine/ClockSyncMonitor';
import { SignerAdapter } from '../engine/SignerAdapter';
import { ProviderHealthManager } from '../engine/ProviderHealthManager';
import { CopyMintEngine } from '../engine/CopyMintEngine';
import { mintEnv, isMintAdminDiscordId, resolvedMainnetBetaWalletAddress } from '../config/mintEnv';
import { getEffectiveEmergencyStop, setRuntimeEmergencyStop } from '../engine/emergencyRuntime';
import { mergeMintJobMetadataJson } from '../engine/mintJobPreflightPersist';
import { AuditLogService } from '../engine/AuditLogService';

let mintJobsTotal = 0;
let mintJobsSucceeded = 0;
let mintJobsFailed = 0;

export function registerMintRoutes(
    app: Router,
    deps: { prisma: PrismaClient; redis: IORedis | null; rpcUrl: string | null },
): void {
    const engine = new MintExecutionEngine(deps.prisma, deps.redis, deps.rpcUrl);
    const clock = new ClockSyncMonitor(deps.rpcUrl);
    const signer = new SignerAdapter();
    const providers = new ProviderHealthManager(deps.prisma);
    const copy = new CopyMintEngine(deps.prisma);

    const r = (path: string, handler: (req: Request, res: Response) => Promise<void>) => {
        app.post(path, (req, res) => {
            void handler(req, res).catch(err => {
                console.error('[mintRoutes]', err);
                res.status(500).json({ error: 'INTERNAL' });
            });
        });
    };

    r('/status', async (req, res) => {
        const drift = await clock.measureDriftMs();
        const healthRows = await deps.prisma.mintProviderHealth.findMany({ take: 20 });
        const queueDepth = 0;
        const recentFailures = await deps.prisma.mintJob.findMany({
            where: { status: { in: ['failed', 'preflight_failed'] } },
            orderBy: { updatedAt: 'desc' },
            take: 5,
            select: { id: true, errorCode: true, updatedAt: true },
        });
        const effectiveEmergency = await getEffectiveEmergencyStop(deps.prisma);
        const activeMainnetStatuses = [
            'created',
            'preflight_running',
            'preflight_passed',
            'nonce_locked',
            'submitted',
            'pending_confirmation',
            'dry_run_running',
        ];
        const activeMainnetJobCount = await deps.prisma.mintJob.count({
            where: { chainId: 1, status: { in: activeMainnetStatuses } },
        });
        const signerMode = signer.resolveMode();
        const signerMainnetApproved = signer.signerMainnetApproved();
        res.json({
            engineMode: mintEnv.MINT_ENGINE_MODE,
            liveExecutionEnabled: mintEnv.MINT_EXECUTION_ENABLED,
            mainnetBroadcastEnabled: mintEnv.MINT_MAINNET_BROADCAST_ENABLED,
            mainnetBetaEnabled: mintEnv.MINT_MAINNET_BETA,
            defaultChainId: mintEnv.MINT_DEFAULT_CHAIN_ID,
            emergencyStopEnv: mintEnv.MINT_EMERGENCY_STOP,
            emergencyStopEffective: effectiveEmergency,
            mainnetDryRunEnabled: mintEnv.MINT_MAINNET_DRY_RUN,
            mainnetBetaWalletConfigured: Boolean(resolvedMainnetBetaWalletAddress()),
            mainnetMaxActiveJobs: mintEnv.MINT_MAINNET_MAX_ACTIVE_JOBS,
            mainnetMaxQuantity: mintEnv.MINT_MAINNET_MAX_QUANTITY,
            activeMainnetJobCount,
            signerMode,
            signerMainnetApproved,
            signerAddressMasked: signer.signerAddressMasked(),
            signerBlockReason: signer.signerBlockReason(),
            testnetOnly: mintEnv.MINT_TESTNET_ONLY,
            signerConfigured: signer.signerConfigured(),
            rpcHealth: healthRows,
            queueDepth,
            clockDrift: drift,
            recentFailures,
            disclaimers: [
                'Execution tools are automation-based and not financial advice.',
                'Mint success is not guaranteed.',
                'Never share seed phrases or private keys.',
                'Transactions may fail or cost gas.',
            ],
        });
    });

    r('/preflight', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const execRaw = b.executionMode != null ? String(b.executionMode) : undefined;
        const execMode =
            execRaw === 'prepare' || execRaw === 'simulation' || execRaw === 'live' || execRaw === 'mainnet_dry_run'
                ? execRaw
                : mintEnv.MINT_ENGINE_MODE === 'live'
                  ? 'prepare'
                  : (mintEnv.MINT_ENGINE_MODE as 'simulation' | 'prepare');
        const out = await engine.preflight({
            guildDiscordId: String(b.guildDiscordId ?? ''),
            userDiscordId: String(b.userDiscordId ?? ''),
            walletAddress: String(b.walletAddress ?? ''),
            collectionAddress: String(b.collectionAddress ?? ''),
            mintContract: b.mintContract ? String(b.mintContract) : undefined,
            dropSource: String(b.dropSource ?? 'opensea'),
            chainId: Number(b.chainId ?? mintEnv.MINT_DEFAULT_CHAIN_ID),
            quantity: Math.max(1, Number(b.quantity ?? 1)),
            executionMode: execMode,
            persistJobId: b.persistJobId ? String(b.persistJobId) : undefined,
        });
        res.json(out);
    });

    r('/jobs', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const defaultMode =
            mintEnv.MINT_ENGINE_MODE === 'live' || mintEnv.MINT_ENGINE_MODE === 'prepare'
                ? 'prepare'
                : 'simulation';
        const created = await engine.createMintJob({
            guildDiscordId: String(b.guildDiscordId ?? ''),
            userDiscordId: String(b.userDiscordId ?? ''),
            walletAddress: String(b.walletAddress ?? ''),
            collectionAddress: String(b.collectionAddress ?? ''),
            mintContract: String(b.mintContract ?? b.collectionAddress ?? ''),
            dropSource: String(b.dropSource ?? 'opensea'),
            dropType: String(b.dropType ?? 'unknown'),
            triggerType: String(b.triggerType ?? 'MANUAL_PREFLIGHT'),
            executionMode: String(b.executionMode ?? defaultMode),
            chainId: Number(b.chainId ?? mintEnv.MINT_DEFAULT_CHAIN_ID),
            quantity: Math.max(1, Number(b.quantity ?? 1)),
        });
        if ('error' in created) {
            res.status(400).json(created);
            return;
        }
        mintJobsTotal++;
        const jobIdSafe = `mintjob_${created.id}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
        await mintExecutionQueue
            .add('process_mint_job', { mintJobId: created.id }, { jobId: jobIdSafe })
            .catch((err: unknown) => console.warn('[mintRoutes] enqueue mint_execution failed:', err));
        res.json(created);
    });

    r('/jobs/list', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const guild = await deps.prisma.guild.findUnique({ where: { discordId: String(b.guildDiscordId ?? '') } });
        if (!guild) {
            res.status(404).json({ error: 'GUILD_NOT_FOUND' });
            return;
        }
        const userDiscordId = b.userDiscordId ? String(b.userDiscordId) : '';
        const user = userDiscordId ? await deps.prisma.user.findUnique({ where: { discordId: userDiscordId } }) : null;
        const jobs = await deps.prisma.mintJob.findMany({
            where: { guildId: guild.id, ...(user ? { userId: user.id } : {}) },
            orderBy: { createdAt: 'desc' },
            take: 25,
        });
        res.json({ jobs });
    });

    r('/jobs/result', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const id = String(b.jobId ?? '');
        const job = await deps.prisma.mintJob.findUnique({
            where: { id },
            include: { simulations: { orderBy: { checkedAt: 'desc' }, take: 3 }, transactions: true },
        });
        if (!job) {
            res.status(404).json({ error: 'NOT_FOUND' });
            return;
        }
        res.json({ job });
    });

    r('/jobs/cancel', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const id = String(b.jobId ?? '');
        const job = await deps.prisma.mintJob.findUnique({ where: { id } });
        if (!job) {
            res.status(404).json({ error: 'NOT_FOUND' });
            return;
        }
        const cancellable = ['created', 'resolving_drop', 'drop_resolved', 'simulated', 'ready', 'scheduled', 'nonce_locked'];
        if (!cancellable.includes(job.status)) {
            res.status(400).json({ error: 'NOT_CANCELLABLE', status: job.status });
            return;
        }
        await deps.prisma.mintJob.update({ where: { id }, data: { status: 'cancelled' } });
        res.json({ ok: true, id });
    });

    r('/copy-config/list', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const guild = await deps.prisma.guild.findUnique({ where: { discordId: String(b.guildDiscordId ?? '') } });
        const user = await deps.prisma.user.findUnique({ where: { discordId: String(b.userDiscordId ?? '') } });
        if (!guild || !user) {
            res.status(404).json({ error: 'NOT_FOUND' });
            return;
        }
        const rows = await copy.listConfigs(guild.id, user.id);
        res.json({ configs: rows });
    });

    r('/copy-config/save', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const guild = await deps.prisma.guild.findUnique({ where: { discordId: String(b.guildDiscordId ?? '') } });
        const user = await deps.prisma.user.findUnique({ where: { discordId: String(b.userDiscordId ?? '') } });
        if (!guild || !user) {
            res.status(404).json({ error: 'NOT_FOUND' });
            return;
        }
        const row = await copy.upsertConfig({
            id: b.id ? String(b.id) : undefined,
            guildId: guild.id,
            userId: user.id,
            trackedWalletAddress: String(b.trackedWalletAddress ?? ''),
            targetCollectionAddress: b.targetCollectionAddress ? String(b.targetCollectionAddress) : null,
            mode: String(b.mode ?? 'confirmed_only'),
            executionWalletId: String(b.executionWalletId ?? ''),
            quantity: Math.max(1, Number(b.quantity ?? 1)),
            enabled: Boolean(b.enabled ?? true),
        });
        if (!row) {
            res.status(404).json({ error: 'COPY_CONFIG_NOT_FOUND' });
            return;
        }
        res.json({ config: row });
    });

    r('/settings/guild', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const guild = await deps.prisma.guild.findUnique({ where: { discordId: String(b.guildDiscordId ?? '') } });
        if (!guild) {
            res.status(404).json({ error: 'GUILD_NOT_FOUND' });
            return;
        }
        const cur = (guild.settings as Record<string, unknown> | null) ?? {};
        const mint = { ...(typeof cur.mintEngine === 'object' && cur.mintEngine ? (cur.mintEngine as object) : {}), ...(b.patch as object) };
        await deps.prisma.guild.update({
            where: { id: guild.id },
            data: { settings: { ...cur, mintEngine: mint } as object },
        });
        res.json({ ok: true });
    });

    r('/runtime/emergency-stop', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const adminDiscordId = String(b.adminDiscordId ?? b.userDiscordId ?? '');
        if (!isMintAdminDiscordId(adminDiscordId)) {
            res.status(403).json({ error: 'MINT_ADMIN_REQUIRED' });
            return;
        }
        await setRuntimeEmergencyStop(deps.prisma, true);
        res.json({ ok: true, emergencyStopEffective: true });
    });

    r('/runtime/emergency-resume', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const adminDiscordId = String(b.adminDiscordId ?? b.userDiscordId ?? '');
        if (!isMintAdminDiscordId(adminDiscordId)) {
            res.status(403).json({ error: 'MINT_ADMIN_REQUIRED' });
            return;
        }
        await setRuntimeEmergencyStop(deps.prisma, false);
        const effective = await getEffectiveEmergencyStop(deps.prisma);
        res.json({ ok: true, emergencyStopEffective: effective });
    });

    r('/jobs/confirm-mainnet', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const adminDiscordId = String(b.adminDiscordId ?? b.userDiscordId ?? '');
        if (!isMintAdminDiscordId(adminDiscordId)) {
            res.status(403).json({ error: 'MINT_ADMIN_REQUIRED' });
            return;
        }
        const jobId = String(b.jobId ?? '');
        if (!jobId) {
            res.status(400).json({ error: 'JOB_ID_REQUIRED' });
            return;
        }
        const job = await deps.prisma.mintJob.findUnique({ where: { id: jobId } });
        if (!job) {
            res.status(404).json({ error: 'NOT_FOUND' });
            return;
        }
        if (job.chainId !== 1 || job.executionMode !== 'live') {
            res.status(400).json({ error: 'MAINNET_LIVE_JOB_REQUIRED' });
            return;
        }
        await mergeMintJobMetadataJson(deps.prisma, jobId, {
            mainnetConfirmed: true,
            mainnetConfirmedAt: new Date().toISOString(),
            mainnetConfirmedByDiscordId: adminDiscordId,
        });
        res.json({ ok: true, jobId });
    });

    r('/mainnet-approval/grant', async (req, res) => {
        const audit = new AuditLogService(deps.prisma);
        const b = req.body as Record<string, unknown>;
        const adminDiscordId = String(b.adminDiscordId ?? '');
        if (!isMintAdminDiscordId(adminDiscordId)) {
            res.status(403).json({ error: 'MINT_ADMIN_REQUIRED' });
            return;
        }
        const guildDiscordId = String(b.guildDiscordId ?? '');
        const userDiscordId = String(b.userDiscordId ?? '');
        const walletAddress = String(b.walletAddress ?? '').toLowerCase();
        const maxFeePerGas = String(b.maxFeePerGas ?? '').trim();
        const maxPriorityFeePerGas = String(b.maxPriorityFeePerGas ?? '').trim();
        const maxTotalCostNative = String(b.maxTotalCostNative ?? '').trim();
        const maxQuantity = Math.max(1, Math.floor(Number(b.maxQuantity ?? 1)));
        const expiresAtRaw = String(b.expiresAt ?? '');
        const approvedBy = String(b.approvedByDiscordId ?? adminDiscordId).trim();
        const allowedCollections = b.allowedCollections;
        if (!/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
            res.status(400).json({ error: 'INVALID_WALLET' });
            return;
        }
        if (!maxFeePerGas || !maxPriorityFeePerGas || !maxTotalCostNative) {
            res.status(400).json({ error: 'CAPS_REQUIRED' });
            return;
        }
        const exp = new Date(expiresAtRaw);
        if (!Number.isFinite(exp.getTime()) || exp <= new Date()) {
            res.status(400).json({ error: 'INVALID_EXPIRY' });
            return;
        }
        const guild = await deps.prisma.guild.findUnique({ where: { discordId: guildDiscordId } });
        const user = await deps.prisma.user.findUnique({ where: { discordId: userDiscordId } });
        if (!guild || !user) {
            res.status(404).json({ error: 'NOT_FOUND' });
            return;
        }
        const mw = await deps.prisma.mintWallet.findFirst({
            where: { userId: user.id, address: walletAddress, chainId: 1 },
        });
        if (!mw) {
            res.status(404).json({ error: 'MINT_WALLET_NOT_FOUND' });
            return;
        }
        let collectionsJson: unknown = undefined;
        if (allowedCollections != null) {
            if (!Array.isArray(allowedCollections)) {
                res.status(400).json({ error: 'ALLOWED_COLLECTIONS_INVALID' });
                return;
            }
            collectionsJson = allowedCollections.map((x) => String(x).toLowerCase());
        }
        await deps.prisma.$transaction(async (tx) => {
            await tx.mainnetExecutionApproval.updateMany({
                where: {
                    guildId: guild.id,
                    userId: user.id,
                    mintWalletId: mw.id,
                    approvalStatus: 'active',
                },
                data: { approvalStatus: 'revoked' },
            });
            await tx.mainnetExecutionApproval.create({
                data: {
                    guildId: guild.id,
                    userId: user.id,
                    mintWalletId: mw.id,
                    walletAddress,
                    chainId: 1,
                    approvedBy,
                    approvalStatus: 'active',
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                    maxTotalCostNative,
                    maxQuantity,
                    allowedCollections: collectionsJson !== undefined ? (collectionsJson as object) : undefined,
                    expiresAt: exp,
                },
            });
        });
        await audit.log({
            guildId: guild.id,
            userId: user.id,
            action: 'mainnet_approval_grant',
            status: 'active',
            message: `Granted by discord ${adminDiscordId}`,
            metadata: { walletAddress, expiresAt: exp.toISOString(), maxQuantity },
        });
        res.json({ ok: true });
    });

    r('/mainnet-approval/revoke', async (req, res) => {
        const audit = new AuditLogService(deps.prisma);
        const b = req.body as Record<string, unknown>;
        const adminDiscordId = String(b.adminDiscordId ?? '');
        if (!isMintAdminDiscordId(adminDiscordId)) {
            res.status(403).json({ error: 'MINT_ADMIN_REQUIRED' });
            return;
        }
        const guildDiscordId = String(b.guildDiscordId ?? '');
        const userDiscordId = String(b.userDiscordId ?? '');
        const walletAddress = String(b.walletAddress ?? '').toLowerCase();
        const guild = await deps.prisma.guild.findUnique({ where: { discordId: guildDiscordId } });
        const user = await deps.prisma.user.findUnique({ where: { discordId: userDiscordId } });
        if (!guild || !user) {
            res.status(404).json({ error: 'NOT_FOUND' });
            return;
        }
        const mw = await deps.prisma.mintWallet.findFirst({
            where: { userId: user.id, address: walletAddress, chainId: 1 },
        });
        if (!mw) {
            res.status(404).json({ error: 'MINT_WALLET_NOT_FOUND' });
            return;
        }
        const n = await deps.prisma.mainnetExecutionApproval.updateMany({
            where: {
                guildId: guild.id,
                userId: user.id,
                mintWalletId: mw.id,
                approvalStatus: 'active',
            },
            data: { approvalStatus: 'revoked' },
        });
        await audit.log({
            guildId: guild.id,
            userId: user.id,
            action: 'mainnet_approval_revoke',
            status: 'revoked',
            message: `Revoked by discord ${adminDiscordId}`,
            metadata: { walletAddress, count: n.count },
        });
        res.json({ ok: true, revoked: n.count });
    });

    r('/mainnet-approval/list', async (req, res) => {
        const b = req.body as Record<string, unknown>;
        const adminDiscordId = String(b.adminDiscordId ?? '');
        if (!isMintAdminDiscordId(adminDiscordId)) {
            res.status(403).json({ error: 'MINT_ADMIN_REQUIRED' });
            return;
        }
        const guildDiscordId = String(b.guildDiscordId ?? '');
        if (!guildDiscordId) {
            res.status(400).json({ error: 'GUILD_REQUIRED' });
            return;
        }
        const guild = await deps.prisma.guild.findUnique({ where: { discordId: guildDiscordId } });
        if (!guild) {
            res.status(404).json({ error: 'GUILD_NOT_FOUND' });
            return;
        }
        const filterUserDiscordId = String(b.userDiscordId ?? '').trim();
        const where: {
            guildId: string;
            approvalStatus: string;
            expiresAt: { gt: Date };
            user?: { discordId: string };
        } = {
            guildId: guild.id,
            approvalStatus: 'active',
            expiresAt: { gt: new Date() },
        };
        if (filterUserDiscordId) {
            where.user = { discordId: filterUserDiscordId };
        }
        const rows = await deps.prisma.mainnetExecutionApproval.findMany({
            where,
            orderBy: { expiresAt: 'asc' },
            take: 25,
            include: { user: { select: { discordId: true } }, mintWallet: { select: { address: true } } },
        });
        res.json({
            ok: true,
            approvals: rows.map((row) => ({
                id: row.id,
                userDiscordId: row.user.discordId,
                walletAddress: row.walletAddress,
                chainId: row.chainId,
                maxQuantity: row.maxQuantity,
                expiresAt: row.expiresAt.toISOString(),
                capsPresent: Boolean(row.maxFeePerGas && row.maxPriorityFeePerGas && row.maxTotalCostNative),
                approvedBy: row.approvedBy,
            })),
        });
    });

}

export function registerMetricsRoute(app: import('express').Express): void {
    app.get('/metrics', async (_req, res) => {
        res.type('text/plain');
        res.send(
            [
                `mint_jobs_total ${mintJobsTotal}`,
                `mint_jobs_succeeded ${mintJobsSucceeded}`,
                `mint_jobs_failed ${mintJobsFailed}`,
            ].join('\n') + '\n',
        );
    });
}

export function bumpMintJobMetric(kind: 'succeeded' | 'failed'): void {
    if (kind === 'succeeded') mintJobsSucceeded++;
    else mintJobsFailed++;
}
