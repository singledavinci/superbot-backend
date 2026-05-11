import type { PrismaClient } from '@superbot/database';
import { mintEnv, isLiveEngineMode } from '../config/mintEnv';
import { DropResolver } from './DropResolver';
import { TransactionPlanner, type ExecutionMode } from './TransactionPlanner';
import { TransactionBuilder } from './TransactionBuilder';
import { SimulationEngine } from './SimulationEngine';
import { GasEngine } from './GasEngine';
import { ExecutionPolicyEngine } from './ExecutionPolicyEngine';
import { WalletAuthorization } from './WalletAuthorization';
import { AuditLogService } from './AuditLogService';
import { BenchmarkService } from './BenchmarkService';
import { MainnetReadinessGate } from './MainnetReadinessGate';
import { SignerAdapter } from './SignerAdapter';
import { BroadcastEngine } from './BroadcastEngine';
import { NonceManager } from './NonceManager';
import { preflightBlockReasonFromCode, simulationBlockReason } from './preflightBlockReason';
import { mergeMintJobMetadataJson, persistMintJobPreflightFields } from './mintJobPreflightPersist';
import type IORedis from 'ioredis';

export class MintExecutionEngine {
    private dropResolver: DropResolver;
    private planner = new TransactionPlanner();
    private builder = new TransactionBuilder();
    private policy = new ExecutionPolicyEngine();
    private walletAuth: WalletAuthorization;
    private audit: AuditLogService;
    private benchmark = new BenchmarkService();
    private mainnetGate: MainnetReadinessGate;
    private signer = new SignerAdapter();
    private broadcast = new BroadcastEngine();
    private nonce: NonceManager;

    constructor(
        private prisma: PrismaClient,
        private redis: IORedis | null,
        private rpcUrl: string | null,
    ) {
        this.dropResolver = new DropResolver(prisma, redis);
        this.walletAuth = new WalletAuthorization(prisma);
        this.audit = new AuditLogService(prisma);
        this.mainnetGate = new MainnetReadinessGate(prisma);
        this.nonce = new NonceManager(prisma, redis);
    }

    async preflight(args: {
        guildDiscordId: string;
        userDiscordId: string;
        walletAddress: string;
        collectionAddress: string;
        mintContract?: string;
        dropSource: string;
        chainId: number;
        quantity: number;
        executionMode?: ExecutionMode;
        persistJobId?: string | null;
    }): Promise<Record<string, unknown>> {
        const endBench = this.benchmark.start('prewarm_total_ms');
        const guild = await this.prisma.guild.findUnique({ where: { discordId: args.guildDiscordId } });
        if (!guild) {
            return {
                ok: false,
                error: 'GUILD_NOT_FOUND',
                resolverStatus: 'not_run',
                blockReason: preflightBlockReasonFromCode('GUILD_NOT_FOUND'),
            };
        }
        const user = await this.prisma.user.findUnique({ where: { discordId: args.userDiscordId } });
        if (!user) {
            return {
                ok: false,
                error: 'USER_NOT_FOUND',
                resolverStatus: 'not_run',
                blockReason: preflightBlockReasonFromCode('USER_NOT_FOUND'),
            };
        }

        const addr = args.walletAddress.toLowerCase();
        const wallet = await this.prisma.mintWallet.findFirst({
            where: { userId: user.id, address: addr, chainId: args.chainId },
        });
        if (!wallet) {
            return {
                ok: false,
                error: 'MINT_WALLET_NOT_FOUND',
                resolverStatus: 'not_run',
                blockReason: preflightBlockReasonFromCode('MINT_WALLET_NOT_FOUND'),
            };
        }

        const can = await this.walletAuth.canAct({
            guildId: guild.id,
            userId: user.id,
            mintWalletId: wallet.id,
            action: 'preflight',
        });
        const simDecision = this.policy.decideSimulation({ walletAuthorized: can });
        if (simDecision !== 'ALLOW_SIMULATION') {
            await this.audit.log({
                guildId: guild.id,
                userId: user.id,
                action: 'preflight_denied',
                status: simDecision,
                message: 'Wallet not authorized for simulation',
            });
            return {
                ok: false,
                error: simDecision,
                resolverStatus: 'not_run',
                blockReason: preflightBlockReasonFromCode(simDecision),
            };
        }

        const execMode: ExecutionMode =
            args.executionMode ??
            (mintEnv.MINT_ENGINE_MODE === 'prepare' ? 'prepare' : mintEnv.MINT_ENGINE_MODE === 'live' ? 'live' : 'simulation');

        if (!this.rpcUrl) {
            const code = 'DEGRADED_PROVIDER_ERROR';
            return {
                ok: false,
                error: code,
                message: 'MINT_ENGINE_RPC_URL (or HTTPS RPC fallback) is not configured',
                resolverStatus: 'not_run',
                blockReason: preflightBlockReasonFromCode(code, 'Missing HTTPS RPC URL for on-chain SeaDrop reads'),
            };
        }

        const dropRes = await this.dropResolver.resolve({
            chainId: args.chainId,
            collectionAddress: args.collectionAddress,
            mintContract: args.mintContract,
            dropSource: args.dropSource,
            rpcUrl: this.rpcUrl,
        });
        if (!dropRes.ok) {
            await this.audit.log({
                guildId: guild.id,
                userId: user.id,
                action: 'preflight_drop',
                status: dropRes.code,
                message: dropRes.message,
            });
            const br = preflightBlockReasonFromCode(dropRes.code, dropRes.message);
            if (args.persistJobId) {
                await this.prisma.mintJob
                    .update({
                        where: { id: args.persistJobId },
                        data: {
                            simulationStatus: dropRes.code,
                            errorCode: dropRes.code,
                        },
                    })
                    .catch(() => undefined);
                await mergeMintJobMetadataJson(this.prisma, args.persistJobId, {
                    preflightLast: {
                        at: new Date().toISOString(),
                        resolverStatus: 'failed',
                        blockReason: br,
                        signingOccurred: false,
                        broadcastOccurred: false,
                    },
                }).catch(() => undefined);
            }
            return {
                ok: false,
                error: dropRes.code,
                message: dropRes.message,
                drop: null,
                resolverStatus: 'failed',
                blockReason: br,
            };
        }

        if (dropRes.drop.requiresProof || dropRes.drop.requiresSignature) {
            const msg = 'Drop requires merkle proof or server signature; unsupported until public SeaDrop path is proven end-to-end';
            const br = preflightBlockReasonFromCode('FAIL_MISSING_PROOF', msg);
            return {
                ok: false,
                error: 'FAIL_MISSING_PROOF',
                message: msg,
                verifiedDrop: dropRes.drop,
                resolverStatus: 'ok',
                blockReason: br,
            };
        }

        const gasEngine = new GasEngine(this.rpcUrl);
        const gas = await gasEngine.buildStrategy({ gasLimit: 350_000n, urgency: 'balanced' });
        const planned = this.planner.buildPlan({
            chainId: args.chainId,
            executionMode: execMode === 'live' ? 'prepare' : execMode,
            drop: dropRes.drop,
            walletAddress: addr,
            quantity: args.quantity,
            maxFeePerGasWei: gas.maxFeePerGas,
            maxPriorityFeePerGasWei: gas.maxPriorityFeePerGas,
            gasLimit: gas.gasLimit,
        });
        if (!planned.ok) {
            await this.audit.log({
                guildId: guild.id,
                userId: user.id,
                action: 'preflight_plan',
                status: planned.code,
                message: planned.message,
            });
            const br = preflightBlockReasonFromCode(planned.code, planned.message);
            if (args.persistJobId) {
                await this.prisma.mintJob
                    .update({
                        where: { id: args.persistJobId },
                        data: { errorCode: planned.code },
                    })
                    .catch(() => undefined);
                await mergeMintJobMetadataJson(this.prisma, args.persistJobId, {
                    preflightLast: {
                        at: new Date().toISOString(),
                        resolverStatus: 'ok',
                        blockReason: br,
                        signingOccurred: false,
                        broadcastOccurred: false,
                    },
                }).catch(() => undefined);
            }
            return {
                ok: false,
                error: planned.code,
                message: planned.message,
                verifiedDrop: dropRes.drop,
                resolverStatus: 'ok',
                blockReason: br,
            };
        }

        const { plan, planHash } = planned;
        let unsigned;
        try {
            unsigned = this.builder.buildUnsigned(plan);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            const br = preflightBlockReasonFromCode('BUILD_TX_FAILED', msg);
            if (args.persistJobId) {
                await this.prisma.mintJob
                    .update({
                        where: { id: args.persistJobId },
                        data: { planHash, errorCode: 'BUILD_TX_FAILED' },
                    })
                    .catch(() => undefined);
                await mergeMintJobMetadataJson(this.prisma, args.persistJobId, {
                    preflightLast: {
                        at: new Date().toISOString(),
                        planHash,
                        blockReason: br,
                        signingOccurred: false,
                        broadcastOccurred: false,
                    },
                }).catch(() => undefined);
            }
            return {
                ok: false,
                error: 'BUILD_TX_FAILED',
                message: msg,
                verifiedDrop: dropRes.drop,
                planHash,
                resolverStatus: 'ok',
                blockReason: br,
            };
        }

        const sim = new SimulationEngine(this.rpcUrl);
        const simRes = await sim.simulate(addr, unsigned, { dropStartMs: dropRes.drop.startTime });

        const preparePayload = this.builder.buildPreparePayload(plan);
        const simOk = simRes.status === 'PASS' || simRes.status === 'PASS_STAGE_NOT_OPEN_YET';
        const simBlock = simulationBlockReason(simRes.status, simRes.revertReason);

        if (args.persistJobId) {
            await sim.persist(this.prisma, args.persistJobId, simRes).catch(() => undefined);
            const errCode = simOk ? null : simRes.status;
            const br = simOk ? null : simBlock ?? preflightBlockReasonFromCode(simRes.status, simRes.revertReason ?? undefined);
            await persistMintJobPreflightFields({
                prisma: this.prisma,
                mintJobId: args.persistJobId,
                planHash,
                simulationStatus: simRes.status,
                errorCode: errCode,
                executionMode: execMode,
                unsignedPrepare: preparePayload,
                blockReason: br,
            }).catch(() => undefined);
        }

        const mainnetOk = await this.mainnetGate.allChecksTrue();
        const liveDecision = this.policy.decideLive({
            walletAuthorized: can,
            simulationOk: simOk,
            simulationStatus: simRes.status,
            signerConfigured: this.signer.signerConfigured(),
            nonceOk: true,
            clockDriftOk: true,
            chainId: args.chainId,
            nonceStateUncertain: false,
            mainnetReadinessOk: args.chainId !== 1 || mainnetOk,
        });

        await this.audit.log({
            guildId: guild.id,
            userId: user.id,
            action: 'preflight',
            mintJobId: args.persistJobId ?? undefined,
            status: simRes.status,
            message: 'preflight complete',
            metadata: { planHash, liveDecision, simulation: simRes },
        });
        endBench();

        const unsignedPreparePresent = Object.keys(preparePayload).length > 0;

        return {
            ok: simOk,
            ...(simOk ? {} : { error: simRes.status }),
            executionMode: execMode,
            engineMode: mintEnv.MINT_ENGINE_MODE,
            liveExecutionEnabled: mintEnv.MINT_EXECUTION_ENABLED && !mintEnv.MINT_EMERGENCY_STOP && isLiveEngineMode(),
            emergencyStop: mintEnv.MINT_EMERGENCY_STOP,
            signingOccurred: false,
            broadcastOccurred: false,
            resolverStatus: 'ok',
            verifiedDrop: dropRes.drop,
            planHash,
            plan: {
                chainId: plan.chainId,
                to: plan.to,
                valueWei: plan.valueWei,
                quantity: plan.quantity,
                gasLimit: plan.gasLimit.toString(10),
                maxFeePerGas: plan.maxFeePerGas.toString(10),
                maxPriorityFeePerGas: plan.maxPriorityFeePerGas.toString(10),
                calldata: plan.calldata,
                mintFunction: plan.mintFunction,
            },
            unsignedPrepare: preparePayload,
            unsignedPreparePresent,
            unsignedPrepareForPrepareMode: execMode === 'prepare',
            simulation: simRes,
            simulationStatus: simRes.status,
            estimatedGasUnits: simRes.gasEstimate,
            livePolicy: liveDecision,
            blockReason: simOk ? null : simBlock ?? preflightBlockReasonFromCode(simRes.status, simRes.revertReason ?? undefined),
            persistJobId: args.persistJobId ?? null,
            benchmarks: this.benchmark.snapshot(),
            disclaimers: [
                'Execution tools are automation-based and not financial advice.',
                'Mint success is not guaranteed.',
                'Never share seed phrases or private keys.',
                'Transactions may fail or cost gas.',
                'Preflight does not sign transactions and does not broadcast.',
            ],
        };
    }

    async createMintJob(args: {
        guildDiscordId: string;
        userDiscordId: string;
        walletAddress: string;
        collectionAddress: string;
        mintContract: string;
        dropSource: string;
        dropType: string;
        triggerType: string;
        executionMode: string;
        chainId: number;
        quantity: number;
    }): Promise<{ id: string } | { error: string; message?: string }> {
        if (args.executionMode === 'live') {
            return { error: 'LIVE_EXECUTION_DISABLED', message: 'Prepare-only beta: live jobs are not accepted' };
        }
        if (args.executionMode !== 'simulation' && args.executionMode !== 'prepare') {
            return { error: 'INVALID_EXECUTION_MODE', message: 'Only simulation or prepare modes are allowed' };
        }

        const guild = await this.prisma.guild.findUnique({ where: { discordId: args.guildDiscordId } });
        if (!guild) return { error: 'GUILD_NOT_FOUND' };
        const user = await this.prisma.user.findUnique({ where: { discordId: args.userDiscordId } });
        if (!user) return { error: 'USER_NOT_FOUND' };
        const wallet = await this.prisma.mintWallet.findFirst({
            where: { userId: user.id, address: args.walletAddress.toLowerCase(), chainId: args.chainId },
        });
        if (!wallet) return { error: 'MINT_WALLET_NOT_FOUND' };
        const can = await this.walletAuth.canAct({
            guildId: guild.id,
            userId: user.id,
            mintWalletId: wallet.id,
            action: 'schedule',
        });
        if (!can) return { error: 'WALLET_NOT_AUTHORIZED' };

        const job = await this.prisma.mintJob.create({
            data: {
                guildId: guild.id,
                userId: user.id,
                walletId: wallet.id,
                chainId: args.chainId,
                collectionAddress: args.collectionAddress.toLowerCase(),
                mintContract: args.mintContract.toLowerCase(),
                dropSource: args.dropSource,
                dropType: args.dropType,
                triggerType: args.triggerType,
                executionMode: args.executionMode,
                status: 'created',
                quantity: args.quantity,
            },
        });
        await this.audit.log({
            mintJobId: job.id,
            guildId: guild.id,
            userId: user.id,
            action: 'job_created',
            status: job.status,
        });
        return { id: job.id };
    }

    get nonceManager(): NonceManager {
        return this.nonce;
    }

    get auditLog(): AuditLogService {
        return this.audit;
    }

    get broadcastEngine(): BroadcastEngine {
        return this.broadcast;
    }

    get signerAdapter(): SignerAdapter {
        return this.signer;
    }
}
