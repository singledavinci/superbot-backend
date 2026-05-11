import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import type { PrismaClient } from '@superbot/database';
import { MintExecutionEngine } from '../engine/MintExecutionEngine';
import { bumpMintJobMetric } from '../http/mintRoutes';
import { mintEnv } from '../config/mintEnv';

export async function startMintExecutionWorkers(args: {
    prisma: PrismaClient;
    redis: IORedis;
    rpcUrl: string | null;
}): Promise<void> {
    const engine = new MintExecutionEngine(args.prisma, args.redis, args.rpcUrl);

    const execWorker = new Worker(
        'mint_execution',
        async (job: Job) => {
            if (job.name === 'process_mint_job') {
                const mintJobId = String(job.data?.mintJobId ?? '');
                if (!mintJobId) return;
                await args.prisma.mintJob.update({
                    where: { id: mintJobId },
                    data: { status: 'preflight_running' },
                });
                const j = await args.prisma.mintJob.findUnique({
                    where: { id: mintJobId },
                    include: { wallet: true, guild: true, user: true },
                });
                if (!j?.wallet?.address || !j.guild || !j.user) return;

                if (j.executionMode === 'live') {
                    const out = await engine.executeLiveMintJob(mintJobId);
                    if (out.ok) bumpMintJobMetric('succeeded');
                    else bumpMintJobMetric('failed');
                    return;
                }

                const execMode = j.executionMode === 'prepare' || j.executionMode === 'simulation' ? j.executionMode : 'prepare';
                const pre = await engine.preflight({
                    guildDiscordId: j.guild.discordId,
                    userDiscordId: j.user.discordId,
                    walletAddress: j.wallet.address,
                    collectionAddress: j.collectionAddress,
                    mintContract: j.mintContract,
                    dropSource: j.dropSource,
                    chainId: j.chainId,
                    quantity: j.quantity,
                    executionMode: execMode,
                    persistJobId: mintJobId,
                });
                if ((pre as { ok?: boolean }).ok) {
                    await args.prisma.mintJob.update({
                        where: { id: mintJobId },
                        data: { status: 'preflight_passed', simulationStatus: String((pre as { simulation?: { status?: string } }).simulation?.status ?? '') },
                    });
                    bumpMintJobMetric('succeeded');
                } else {
                    await args.prisma.mintJob.update({
                        where: { id: mintJobId },
                        data: { status: 'preflight_failed', errorCode: String((pre as { error?: string }).error ?? 'UNKNOWN') },
                    });
                    bumpMintJobMetric('failed');
                }
            }
            if (job.name === 'preflight_tick') {
                const mintJobId = String(job.data?.mintJobId ?? '');
                const tick = String(job.data?.tick ?? '');
                await args.prisma.mintAuditLog.create({
                    data: {
                        mintJobId,
                        action: 'scheduler_tick',
                        status: tick,
                        message: 'Preflight timeline tick',
                    },
                });
            }
        },
        { connection: args.redis, concurrency: mintEnv.MINT_MAX_CONCURRENT_JOBS },
    );
    execWorker.on('failed', (job, err) => {
        console.error('[mint_execution] job failed', job?.id, err);
    });

    const triggerWorker = new Worker(
        'mint_triggers',
        async (job: Job) => {
            if (job.name === 'COPY_CONFIRMED_MINT') {
                const d = job.data as {
                    trackedWallet?: string;
                    collectionAddress?: string;
                    chainId?: number;
                    txHash?: string;
                };
                if (!d.txHash || !d.trackedWallet || !d.collectionAddress) return;
                await args.prisma.trackedMintTrigger.create({
                    data: {
                        chainId: d.chainId ?? 1,
                        trackedWallet: d.trackedWallet.toLowerCase(),
                        collectionAddress: d.collectionAddress.toLowerCase(),
                        txHash: d.txHash,
                        triggerSource: 'worker_whale_mint',
                        usedForMint: false,
                    },
                });
            }
        },
        { connection: args.redis, concurrency: 5 },
    );
    triggerWorker.on('failed', (job, err) => {
        console.error('[mint_triggers] job failed', job?.id, err);
    });

    console.log('[MintEngine] BullMQ workers mint_execution + mint_triggers started');
}
