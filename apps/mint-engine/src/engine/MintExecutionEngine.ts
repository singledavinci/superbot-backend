import type { PrismaClient } from '@superbot/database';
import { JsonRpcProvider, keccak256 } from 'ethers';
import {
    mintEnv,
    isLiveEngineMode,
    mintGasCapsConfigured,
    resolveMainnetRpcUrl,
    resolvedMainnetBetaGuildDiscordId,
    resolvedMainnetBetaUserDiscordId,
    resolvedMainnetBetaWalletAddress,
} from '../config/mintEnv';
import { DropResolver } from './DropResolver';
import { TransactionPlanner, type ExecutionMode, type MintPlan } from './TransactionPlanner';
import { TransactionBuilder, type UnsignedTx } from './TransactionBuilder';
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
import { ResultTracker } from './ResultTracker';
import { getEffectiveEmergencyStop } from './emergencyRuntime';
import { evaluateMainnetStrict } from './mainnetLivePolicy';
import type { MainnetStrictInput } from './mainnetLivePolicy';
import { findActiveMainnetApproval } from './mainnetApprovalQueries';
import { validateMainnetApprovalForLive, validatePlanGasAgainstApproval } from './mainnetApprovalStrict';
import type { PolicyDecision } from './ExecutionPolicyEngine';
import type IORedis from 'ioredis';

function mapMainnetMaterializeError(chainId: number, code: string): string {
    if (chainId !== 1) return code;
    switch (code) {
        case 'FAIL_UNKNOWN_PRICE':
            return 'MAINNET_UNKNOWN_PRICE';
        case 'FAIL_UNKNOWN_FUNCTION':
            return 'MAINNET_UNKNOWN_CALLDATA';
        case 'FAIL_MISSING_PROOF':
            return 'MAINNET_MISSING_PROOF';
        default:
            return code;
    }
}

function mapLivePolicyDecisionToMainnetError(d: PolicyDecision): string {
    switch (d) {
        case 'BLOCK_GAS_CAP':
            return 'MAINNET_GAS_CAP_REQUIRED';
        case 'BLOCK_PROVIDER_UNHEALTHY':
            return 'MAINNET_PROVIDER_UNHEALTHY';
        case 'BLOCK_SIMULATION':
            return 'MAINNET_SIMULATION_REQUIRED';
        case 'BLOCK_EMERGENCY_STOP':
            return 'MAINNET_EMERGENCY_STOP_ACTIVE';
        case 'BLOCK_SIGNER_MISSING':
            return 'MAINNET_SIGNER_NOT_APPROVED';
        case 'BLOCK_MAINNET_READINESS':
        case 'BLOCK_MAINNET_DISABLED':
            return 'MAINNET_DISABLED';
        case 'BLOCK_MAINNET_BETA_DISABLED':
            return 'MAINNET_BETA_DISABLED';
        default:
            return d;
    }
}

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

        const rpcPreflight = args.chainId === 1 ? resolveMainnetRpcUrl() ?? this.rpcUrl : this.rpcUrl;
        if (!rpcPreflight) {
            const code = 'DEGRADED_PROVIDER_ERROR';
            return {
                ok: false,
                error: code,
                message:
                    args.chainId === 1
                        ? 'MINT_MAINNET_RPC_URL (or engine default RPC) is not configured for chainId 1'
                        : 'MINT_ENGINE_RPC_URL (or HTTPS RPC fallback) is not configured',
                resolverStatus: 'not_run',
                blockReason: preflightBlockReasonFromCode(code, 'Missing HTTPS RPC URL for on-chain SeaDrop reads'),
            };
        }

        const dropRes = await this.dropResolver.resolve({
            chainId: args.chainId,
            collectionAddress: args.collectionAddress,
            mintContract: args.mintContract,
            dropSource: args.dropSource,
            rpcUrl: rpcPreflight,
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

        const gasEngine = new GasEngine(rpcPreflight);
        const gas = await gasEngine.buildStrategy({ gasLimit: 350_000n, urgency: 'balanced' });
        const planned = this.planner.buildPlan({
            chainId: args.chainId,
            executionMode: execMode,
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

        const sim = new SimulationEngine(rpcPreflight);
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
        const addr = args.walletAddress.toLowerCase();

        if (args.executionMode === 'mainnet_dry_run') {
            if (args.chainId !== 1) return { error: 'INVALID_CHAIN', message: 'mainnet_dry_run requires chainId=1' };
            if (!mintEnv.MINT_MAINNET_DRY_RUN) return { error: 'MAINNET_DRY_RUN_DISABLED', message: 'Set MINT_MAINNET_DRY_RUN=true' };
            if (!resolveMainnetRpcUrl()) return { error: 'MAINNET_RPC_REQUIRED', message: 'Set MINT_MAINNET_RPC_URL' };
            if (args.quantity < 1 || args.quantity > mintEnv.MINT_MAINNET_MAX_QUANTITY) {
                return {
                    error: 'MAINNET_QUANTITY_CAP_EXCEEDED',
                    message: `Mainnet dry-run quantity must be 1..${mintEnv.MINT_MAINNET_MAX_QUANTITY}`,
                };
            }
            if (!this.betaEnvMatches(args.guildDiscordId, args.userDiscordId, addr)) {
                return { error: 'MAINNET_BETA_GUILD_MISMATCH', message: 'Guild/user/wallet does not match mainnet beta env' };
            }
        } else if (args.executionMode === 'live') {
            if (!mintEnv.MINT_EXECUTION_ENABLED || !isLiveEngineMode()) {
                return {
                    error: 'LIVE_EXECUTION_DISABLED',
                    message: 'Set MINT_EXECUTION_ENABLED=true and MINT_ENGINE_MODE=live for live jobs',
                };
            }
            if (args.chainId === 1) {
                if (!mintEnv.MINT_MAINNET_BROADCAST_ENABLED || mintEnv.MINT_TESTNET_ONLY) {
                    return { error: 'MAINNET_DISABLED', message: 'Enable MINT_MAINNET_BROADCAST_ENABLED and MINT_TESTNET_ONLY=false' };
                }
                if (!mintEnv.MINT_MAINNET_BETA) {
                    return { error: 'MAINNET_BETA_DISABLED', message: 'Set MINT_MAINNET_BETA=true for mainnet live jobs' };
                }
                if (args.quantity < 1 || args.quantity > mintEnv.MINT_MAINNET_MAX_QUANTITY) {
                    return {
                        error: 'MAINNET_QUANTITY_CAP_EXCEEDED',
                        message: `Mainnet live quantity must be 1..${mintEnv.MINT_MAINNET_MAX_QUANTITY}`,
                    };
                }
                if (!this.betaEnvMatches(args.guildDiscordId, args.userDiscordId, addr)) {
                    return { error: 'MAINNET_BETA_GUILD_MISMATCH', message: 'Guild/user/wallet does not match mainnet beta env' };
                }
            } else if (mintEnv.MINT_TESTNET_ONLY && args.chainId !== mintEnv.MINT_DEFAULT_CHAIN_ID) {
                return {
                    error: 'TESTNET_CHAIN_MISMATCH',
                    message: `When MINT_TESTNET_ONLY=true, live jobs must use MINT_DEFAULT_CHAIN_ID (${mintEnv.MINT_DEFAULT_CHAIN_ID})`,
                };
            }
        } else if (args.executionMode !== 'simulation' && args.executionMode !== 'prepare') {
            return { error: 'INVALID_EXECUTION_MODE', message: 'Invalid execution mode' };
        }

        const guild = await this.prisma.guild.findUnique({ where: { discordId: args.guildDiscordId } });
        if (!guild) return { error: 'GUILD_NOT_FOUND' };
        const user = await this.prisma.user.findUnique({ where: { discordId: args.userDiscordId } });
        if (!user) return { error: 'USER_NOT_FOUND' };
        const wallet = await this.prisma.mintWallet.findFirst({
            where: { userId: user.id, address: addr, chainId: args.chainId },
        });
        if (!wallet) return { error: 'MINT_WALLET_NOT_FOUND' };

        if (args.executionMode === 'live' && args.chainId === 1) {
            const approval = await findActiveMainnetApproval(this.prisma, {
                userId: user.id,
                guildId: guild.id,
                mintWalletId: wallet.id,
            });
            const apprErr = validateMainnetApprovalForLive(approval, {
                guildId: guild.id,
                userId: user.id,
                mintWalletId: wallet.id,
                walletAddressLower: addr,
                chainId: 1,
                quantity: args.quantity,
                collectionLower: args.collectionAddress.toLowerCase(),
            });
            if (apprErr) return { error: apprErr, message: apprErr };
        }
        const singleFlightMainnet =
            (args.executionMode === 'live' && args.chainId === 1) || args.executionMode === 'mainnet_dry_run';
        if (singleFlightMainnet) {
            const nActive = await this.countActiveMainnetJobsForWallet(wallet.id);
            if (nActive >= mintEnv.MINT_MAINNET_MAX_ACTIVE_JOBS) {
                return {
                    error: 'MAINNET_ACTIVE_JOB_LIMIT',
                    message: `Mainnet active job limit reached (${mintEnv.MINT_MAINNET_MAX_ACTIVE_JOBS})`,
                };
            }
        }

        const authAction =
            args.executionMode === 'live' ? 'live' : args.executionMode === 'mainnet_dry_run' ? 'schedule' : 'schedule';
        const can = await this.walletAuth.canAct({
            guildId: guild.id,
            userId: user.id,
            mintWalletId: wallet.id,
            action: authAction,
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

    private rpcForJobChain(chainId: number): string | null {
        if (chainId === 1) return resolveMainnetRpcUrl();
        return this.rpcUrl;
    }

    private async checkProviderHealthyForLive(rpcUrl: string | null): Promise<boolean> {
        if (!rpcUrl) return false;
        try {
            const p = new JsonRpcProvider(rpcUrl);
            await p.getBlockNumber();
            return true;
        } catch {
            return false;
        }
    }

    private async countActiveWalletJobs(walletId: string, excludeJobId?: string): Promise<number> {
        const active = [
            'created',
            'preflight_running',
            'preflight_passed',
            'nonce_locked',
            'submitted',
            'pending_confirmation',
            'dry_run_running',
        ];
        return this.prisma.mintJob.count({
            where: {
                walletId,
                id: excludeJobId ? { not: excludeJobId } : undefined,
                status: { in: active },
            },
        });
    }

    private async countActiveMainnetJobsForWallet(walletId: string, excludeJobId?: string): Promise<number> {
        const active = [
            'created',
            'preflight_running',
            'preflight_passed',
            'nonce_locked',
            'submitted',
            'pending_confirmation',
            'dry_run_running',
        ];
        return this.prisma.mintJob.count({
            where: {
                walletId,
                chainId: 1,
                id: excludeJobId ? { not: excludeJobId } : undefined,
                status: { in: active },
            },
        });
    }

    private betaEnvMatches(guildDiscordId: string, userDiscordId: string, walletLower: string): boolean {
        const w = resolvedMainnetBetaWalletAddress();
        const g = resolvedMainnetBetaGuildDiscordId();
        const u = resolvedMainnetBetaUserDiscordId();
        if (mintEnv.MINT_MAINNET_BETA) {
            if (!w || !g || !u) return false;
            return walletLower === w && guildDiscordId === g && userDiscordId === u;
        }
        if (!w && !g && !u) return true;
        if (w && walletLower !== w) return false;
        if (g && guildDiscordId !== g) return false;
        if (u && userDiscordId !== u) return false;
        return true;
    }

    /** Resolve drop + plan + unsigned tx (simulation expects missing nonce in unsigned for eth_call). */
    private async materializeUnsignedForJob(
        job: {
            chainId: number;
            collectionAddress: string;
            mintContract: string;
            dropSource: string;
            quantity: number;
            walletAddress: string;
        },
        rpcUrl: string,
    ): Promise<
        | {
              ok: true;
              plan: MintPlan;
              planHash: string;
              unsigned: UnsignedTx;
              dropStartMs: number | null;
          }
        | { ok: false; code: string; message: string }
    > {
        if (!rpcUrl.trim()) return { ok: false, code: 'NO_RPC', message: 'HTTPS RPC not configured' };
        const dropRes = await this.dropResolver.resolve({
            chainId: job.chainId,
            collectionAddress: job.collectionAddress,
            mintContract: job.mintContract,
            dropSource: job.dropSource,
            rpcUrl,
        });
        if (!dropRes.ok) return { ok: false, code: dropRes.code, message: dropRes.message };
        if (dropRes.drop.requiresProof || dropRes.drop.requiresSignature) {
            return { ok: false, code: 'FAIL_MISSING_PROOF', message: 'Drop requires proof or signature' };
        }
        const gasEngine = new GasEngine(rpcUrl);
        const gas = await gasEngine.buildStrategy({ gasLimit: 350_000n, urgency: 'balanced' });
        const planned = this.planner.buildPlan({
            chainId: job.chainId,
            executionMode: 'live',
            drop: dropRes.drop,
            walletAddress: job.walletAddress.toLowerCase(),
            quantity: job.quantity,
            maxFeePerGasWei: gas.maxFeePerGas,
            maxPriorityFeePerGasWei: gas.maxPriorityFeePerGas,
            gasLimit: gas.gasLimit,
        });
        if (!planned.ok) return { ok: false, code: planned.code, message: planned.message };
        try {
            const unsigned = this.builder.buildUnsigned(planned.plan);
            return {
                ok: true,
                plan: planned.plan,
                planHash: planned.planHash,
                unsigned,
                dropStartMs: dropRes.drop.startTime,
            };
        } catch (e: unknown) {
            return {
                ok: false,
                code: 'BUILD_TX_FAILED',
                message: e instanceof Error ? e.message : String(e),
            };
        }
    }

    /**
     * Mainnet dry-run: real RPC + resolver + sim + simulated nonce lock; never sign or broadcast.
     */
    async executeMainnetDryRunJob(mintJobId: string): Promise<{ ok: boolean; error?: string }> {
        const job = await this.prisma.mintJob.findUnique({
            where: { id: mintJobId },
            include: { wallet: true, guild: true, user: true },
        });
        if (!job?.wallet || !job.guild || !job.user) {
            return { ok: false, error: 'JOB_NOT_FOUND' };
        }
        if (job.executionMode !== 'mainnet_dry_run') {
            return { ok: false, error: 'NOT_DRY_RUN_JOB' };
        }
        if (job.chainId !== 1) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'INVALID_CHAIN' },
            });
            return { ok: false, error: 'INVALID_CHAIN' };
        }

        await this.prisma.mintJob.update({
            where: { id: mintJobId },
            data: { status: 'dry_run_running' },
        });

        const rpc = resolveMainnetRpcUrl();
        if (!rpc) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'MAINNET_RPC_REQUIRED' },
            });
            return { ok: false, error: 'MAINNET_RPC_REQUIRED' };
        }

        const addr = job.wallet.address.toLowerCase();
        const mat = await this.materializeUnsignedForJob(
            {
                chainId: job.chainId,
                collectionAddress: job.collectionAddress,
                mintContract: job.mintContract,
                dropSource: job.dropSource,
                quantity: job.quantity,
                walletAddress: addr,
            },
            rpc,
        );
        if (!mat.ok) {
            const code = mapMainnetMaterializeError(job.chainId, mat.code);
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'preflight_failed', errorCode: code },
            });
            return { ok: false, error: code };
        }

        const sim = new SimulationEngine(rpc);
        const simRes = await sim.simulate(addr, mat.unsigned, { dropStartMs: mat.dropStartMs });
        await sim.persist(this.prisma, mintJobId, simRes).catch(() => undefined);

        if (simRes.status !== 'PASS') {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'preflight_failed', simulationStatus: simRes.status, errorCode: simRes.status },
            });
            return { ok: false, error: simRes.status };
        }

        const canSchedule = await this.walletAuth.canAct({
            guildId: job.guildId,
            userId: job.userId,
            mintWalletId: job.walletId,
            action: 'schedule',
        });
        if (!canSchedule) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: 'WALLET_NOT_AUTHORIZED' },
            });
            return { ok: false, error: 'WALLET_NOT_AUTHORIZED' };
        }

        const gasEngine = new GasEngine(rpc);
        const costOk = gasEngine.validatePlanTotalCost(mat.plan);
        if (!costOk.ok) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: 'MAINNET_COST_CAP_REQUIRED', errorMessage: costOk.message },
            });
            return { ok: false, error: costOk.message };
        }

        const providerOk = await this.checkProviderHealthyForLive(rpc);
        const jobAgeMin = (Date.now() - job.createdAt.getTime()) / 60_000;
        const jobExpired = jobAgeMin > mintEnv.MINT_JOB_MAX_AGE_MINUTES;
        const emergencyDry = await getEffectiveEmergencyStop(this.prisma);
        const strictIn: MainnetStrictInput = {
            phase: 'dry_run',
            chainId: 1,
            emergencyStopActive: emergencyDry,
            executionEnabled: mintEnv.MINT_EXECUTION_ENABLED,
            engineModeLive: isLiveEngineMode(),
            mainnetBroadcastEnabled: mintEnv.MINT_MAINNET_BROADCAST_ENABLED,
            testnetOnly: mintEnv.MINT_TESTNET_ONLY,
            mainnetBetaEnabled: mintEnv.MINT_MAINNET_BETA,
            requireSecureSigner: mintEnv.MINT_REQUIRE_SECURE_SIGNER,
            walletMainnetApproved: true,
            signerConfigured: true,
            signerMainnetApproved: true,
            simulationPass: true,
            gasCapsConfigured: mintGasCapsConfigured(),
            maxTotalCostSet: !!(mintEnv.MINT_MAX_TOTAL_COST_NATIVE || '').trim(),
            maxFeePerGasSet: !!(mintEnv.MINT_MAX_FEE_GWEI || '').trim(),
            maxPriorityFeePerGasSet: !!(mintEnv.MINT_MAX_PRIORITY_FEE_GWEI || '').trim(),
            providerHealthy: providerOk,
            operatorConfirmationPresent: true,
            jobExpired,
            dropVerified: true,
            betaGuildOk: true,
            betaUserOk: true,
            betaWalletOk: true,
            quantityOk: true,
            concurrentJobsOk: true,
            copyMintDisabledOk: true,
            privateRelayDisabledOk: true,
        };
        const dryBlock = evaluateMainnetStrict(strictIn);
        if (dryBlock) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: dryBlock },
            });
            await this.audit.log({
                mintJobId,
                guildId: job.guildId,
                userId: job.userId,
                action: 'dry_run_blocked',
                status: dryBlock,
                message: 'mainnet dry-run policy',
            });
            return { ok: false, error: dryBlock };
        }

        const liveDecision = this.policy.decideMainnetDryRun({
            walletAuthorized: canSchedule,
            simulationOk: true,
            gasCapsConfigured: mintGasCapsConfigured(),
            providerHealthy: providerOk,
        });
        if (liveDecision !== 'ALLOW_MAINNET_DRY_RUN') {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: liveDecision },
            });
            return { ok: false, error: liveDecision };
        }

        const provider = new JsonRpcProvider(rpc);
        let pendingNonce: number;
        try {
            pendingNonce = await this.nonce.getPendingNonce(provider, addr);
        } catch (e: unknown) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'NONCE_RPC_ERROR' },
            });
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }

        const simLock = await this.nonce.acquireSimulatedLockTx({
            chainId: 1,
            walletAddress: addr,
            nonce: String(pendingNonce),
            mintJobId,
        });
        if (!simLock.ok) {
            const lockCode = simLock.code === 'NONCE_LOCK_CONFLICT' ? 'MAINNET_NONCE_LOCK_REQUIRED' : simLock.code;
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: lockCode },
            });
            return { ok: false, error: lockCode };
        }

        const preparePayload = this.builder.buildPreparePayload(mat.plan);
        const unsignedWithNonce = { ...mat.unsigned, nonce: pendingNonce };
        const calldataHash = keccak256(unsignedWithNonce.data);
        const maxTotalCostNative = mintEnv.MINT_MAX_TOTAL_COST_NATIVE || '';

        await persistMintJobPreflightFields({
            prisma: this.prisma,
            mintJobId,
            planHash: mat.planHash,
            simulationStatus: 'PASS',
            errorCode: null,
            executionMode: 'mainnet_dry_run',
            unsignedPrepare: preparePayload,
            blockReason: null,
        }).catch(() => undefined);

        await mergeMintJobMetadataJson(this.prisma, mintJobId, {
            mainnetDryRun: {
                at: new Date().toISOString(),
                transactionTarget: mat.plan.to,
                valueWei: mat.plan.valueWei,
                calldataHash,
                gasEstimate: simRes.gasEstimate,
                maxFeePerGas: mat.plan.maxFeePerGas.toString(10),
                maxPriorityFeePerGas: mat.plan.maxPriorityFeePerGas.toString(10),
                maxTotalCostNative,
                simulationStatus: 'PASS',
                policyDecision: liveDecision,
                signingOccurred: false,
                broadcastOccurred: false,
                nonceLockSimulated: true,
                pendingNonce,
            },
        }).catch(() => undefined);

        await this.prisma.mintJob.update({
            where: { id: mintJobId },
            data: {
                status: 'mainnet_dry_run_complete',
                planHash: mat.planHash,
                simulationStatus: 'PASS',
                maxFeePerGas: mat.plan.maxFeePerGas.toString(10),
                maxPriorityFeePerGas: mat.plan.maxPriorityFeePerGas.toString(10),
                maxTotalCostNative: maxTotalCostNative || undefined,
            },
        });

        await this.nonce.finalizeLock(mintJobId, 'released');

        await this.audit.log({
            mintJobId,
            guildId: job.guildId,
            userId: job.userId,
            action: 'mainnet_dry_run_complete',
            status: 'PASS',
            message: JSON.stringify({ calldataHash, policyDecision: liveDecision }),
        });

        return { ok: true };
    }

    /**
     * Live path: simulate → policy → nonce lock → sign → broadcast → receipt.
     * Chain 1 uses `MINT_MAINNET_RPC_URL` and strict `evaluateMainnetStrict` gates.
     */
    async executeLiveMintJob(mintJobId: string): Promise<{ ok: boolean; error?: string; txHash?: string }> {
        const job = await this.prisma.mintJob.findUnique({
            where: { id: mintJobId },
            include: { wallet: true, guild: true, user: true },
        });
        if (!job?.wallet || !job.guild || !job.user) {
            return { ok: false, error: 'JOB_NOT_FOUND' };
        }
        if (job.executionMode !== 'live') {
            return { ok: false, error: 'NOT_LIVE_JOB' };
        }

        const rpc = this.rpcForJobChain(job.chainId);
        if (!rpc) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: job.chainId === 1 ? 'MAINNET_RPC_REQUIRED' : 'NO_RPC' },
            });
            return { ok: false, error: 'NO_RPC' };
        }

        const addr = job.wallet.address.toLowerCase();
        const mat = await this.materializeUnsignedForJob(
            {
                chainId: job.chainId,
                collectionAddress: job.collectionAddress,
                mintContract: job.mintContract,
                dropSource: job.dropSource,
                quantity: job.quantity,
                walletAddress: addr,
            },
            rpc,
        );
        if (!mat.ok) {
            const code = mapMainnetMaterializeError(job.chainId, mat.code);
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'preflight_failed', errorCode: code },
            });
            return { ok: false, error: code };
        }

        if (job.planHash && mat.planHash !== job.planHash) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'PLAN_DRIFT' },
            });
            await this.audit.log({
                mintJobId,
                guildId: job.guildId,
                userId: job.userId,
                action: 'live_blocked',
                status: 'PLAN_DRIFT',
                message: 'planHash mismatch vs persisted job',
            });
            return { ok: false, error: 'PLAN_DRIFT' };
        }

        const sim = new SimulationEngine(rpc);
        const simRes = await sim.simulate(addr, mat.unsigned, { dropStartMs: mat.dropStartMs });
        await sim.persist(this.prisma, mintJobId, simRes).catch(() => undefined);

        if (simRes.status !== 'PASS') {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'preflight_failed', simulationStatus: simRes.status, errorCode: simRes.status },
            });
            return { ok: false, error: simRes.status };
        }

        const canLive = await this.walletAuth.canAct({
            guildId: job.guildId,
            userId: job.userId,
            mintWalletId: job.walletId,
            action: 'live',
        });
        const gasEngine = new GasEngine(rpc);
        const costOk = gasEngine.validatePlanTotalCost(mat.plan);
        if (!costOk.ok) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: 'MAINNET_COST_CAP_REQUIRED', errorMessage: costOk.message },
            });
            return { ok: false, error: costOk.message };
        }

        const emergency = await getEffectiveEmergencyStop(this.prisma);
        const providerOk = await this.checkProviderHealthyForLive(rpc);
        const meta = (job.metadataJson as Record<string, unknown> | null) ?? {};
        const mainnetConfirmed = Boolean(meta.mainnetConfirmed);
        const approval =
            job.chainId === 1
                ? await findActiveMainnetApproval(this.prisma, {
                      userId: job.userId,
                      guildId: job.guildId,
                      mintWalletId: job.walletId,
                  })
                : null;
        const approvalCtxLive =
            job.chainId === 1
                ? {
                      guildId: job.guildId,
                      userId: job.userId,
                      mintWalletId: job.walletId,
                      walletAddressLower: addr,
                      chainId: 1 as const,
                      quantity: job.quantity,
                      collectionLower: job.collectionAddress.toLowerCase(),
                  }
                : null;
        const approvalErrLive = approvalCtxLive ? validateMainnetApprovalForLive(approval, approvalCtxLive) : null;
        const walletMainnetOk = job.chainId !== 1 || !approvalErrLive;

        if (job.chainId === 1 && approval && !approvalErrLive) {
            const planGasErr = validatePlanGasAgainstApproval(mat.plan, approval);
            if (planGasErr) {
                await this.prisma.mintJob.update({
                    where: { id: mintJobId },
                    data: { status: 'blocked', errorCode: planGasErr },
                });
                await this.audit.log({
                    mintJobId,
                    guildId: job.guildId,
                    userId: job.userId,
                    action: 'live_blocked',
                    status: planGasErr,
                    message: 'plan exceeds mainnet approval gas/cost caps',
                });
                return { ok: false, error: planGasErr };
            }
        }

        const modeEarly = this.signer.resolveMode();
        let signerMainnetOk = true;
        if (job.chainId === 1) {
            if (modeEarly === 'external-signer') signerMainnetOk = mintEnv.MINT_MAINNET_SIGNER_APPROVED;
            else if (modeEarly === 'local-dev-signer') signerMainnetOk = mintEnv.MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED;
            else if (modeEarly === 'vault-signer') signerMainnetOk = mintEnv.MINT_MAINNET_SIGNER_APPROVED;
            else signerMainnetOk = false;
        }
        const jobAgeMin = (Date.now() - job.createdAt.getTime()) / 60_000;
        const jobExpired = jobAgeMin > mintEnv.MINT_JOB_MAX_AGE_MINUTES;
        const strictIn: MainnetStrictInput = {
            phase: 'live',
            chainId: job.chainId,
            emergencyStopActive: emergency,
            executionEnabled: mintEnv.MINT_EXECUTION_ENABLED,
            engineModeLive: isLiveEngineMode(),
            mainnetBroadcastEnabled: mintEnv.MINT_MAINNET_BROADCAST_ENABLED,
            testnetOnly: mintEnv.MINT_TESTNET_ONLY,
            mainnetBetaEnabled: mintEnv.MINT_MAINNET_BETA,
            requireSecureSigner: mintEnv.MINT_REQUIRE_SECURE_SIGNER,
            walletMainnetApproved: walletMainnetOk,
            signerConfigured: this.signer.signerConfigured(),
            signerMainnetApproved: signerMainnetOk,
            simulationPass: true,
            gasCapsConfigured: mintGasCapsConfigured(),
            maxTotalCostSet: !!(mintEnv.MINT_MAX_TOTAL_COST_NATIVE || '').trim(),
            maxFeePerGasSet: !!(mintEnv.MINT_MAX_FEE_GWEI || '').trim(),
            maxPriorityFeePerGasSet: !!(mintEnv.MINT_MAX_PRIORITY_FEE_GWEI || '').trim(),
            providerHealthy: providerOk,
            operatorConfirmationPresent:
                job.chainId !== 1 || !mintEnv.MINT_MAINNET_REQUIRE_MANUAL_CONFIRMATION || mainnetConfirmed,
            jobExpired,
            dropVerified: true,
            betaGuildOk: job.chainId !== 1 || this.betaEnvMatches(job.guild.discordId, job.user.discordId, addr),
            betaUserOk: job.chainId !== 1 || this.betaEnvMatches(job.guild.discordId, job.user.discordId, addr),
            betaWalletOk: job.chainId !== 1 || this.betaEnvMatches(job.guild.discordId, job.user.discordId, addr),
            quantityOk:
                job.chainId !== 1 ||
                (job.quantity >= 1 && job.quantity <= mintEnv.MINT_MAINNET_MAX_QUANTITY),
            concurrentJobsOk: true,
            copyMintDisabledOk:
                job.chainId !== 1 ||
                (!mintEnv.MINT_MAINNET_COPY_LIVE_ENABLED &&
                    !mintEnv.MINT_COPY_PENDING_ENABLED &&
                    !mintEnv.MINT_COPY_CONFIRMED_ENABLED),
            privateRelayDisabledOk:
                job.chainId !== 1 ||
                (!mintEnv.MINT_MAINNET_PRIVATE_RELAY_ENABLED && !mintEnv.MINT_ALLOW_PRIVATE_RELAY),
        };
        const concurrentMainnet = await this.countActiveMainnetJobsForWallet(job.walletId, mintJobId);
        strictIn.concurrentJobsOk = job.chainId !== 1 || concurrentMainnet === 0;

        const mainnetStrict = job.chainId === 1 ? evaluateMainnetStrict(strictIn) : null;
        if (mainnetStrict) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: mainnetStrict },
            });
            await this.audit.log({
                mintJobId,
                guildId: job.guildId,
                userId: job.userId,
                action: 'live_blocked',
                status: mainnetStrict,
                message: 'mainnet strict policy',
            });
            return { ok: false, error: mainnetStrict };
        }

        const mainnetOk = await this.mainnetGate.allChecksTrue();
        const liveDecision = this.policy.decideLive({
            walletAuthorized: canLive,
            simulationOk: true,
            simulationStatus: 'PASS',
            signerConfigured: this.signer.signerConfigured(),
            nonceOk: true,
            clockDriftOk: true,
            chainId: job.chainId,
            nonceStateUncertain: false,
            mainnetReadinessOk: job.chainId !== 1 || mainnetOk,
            gasCapsConfigured: mintGasCapsConfigured(),
            providerHealthy: providerOk,
        });

        if (liveDecision !== 'ALLOW_LIVE_EXECUTION') {
            const errCode = job.chainId === 1 ? mapLivePolicyDecisionToMainnetError(liveDecision) : liveDecision;
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: errCode },
            });
            await this.audit.log({
                mintJobId,
                guildId: job.guildId,
                userId: job.userId,
                action: 'live_blocked',
                status: errCode,
                message: 'policy blocked live execution',
            });
            return { ok: false, error: errCode };
        }

        if (modeEarly === 'local-dev-signer') {
            const { Wallet } = await import('ethers');
            const pk = process.env.MINT_LOCAL_DEV_PRIVATE_KEY?.trim();
            if (!pk) {
                await this.prisma.mintJob.update({
                    where: { id: mintJobId },
                    data: { status: 'failed', errorCode: 'SIGNER_NOT_CONFIGURED' },
                });
                return { ok: false, error: 'SIGNER_NOT_CONFIGURED' };
            }
            const w = new Wallet(pk);
            if (w.address.toLowerCase() !== addr) {
                await this.prisma.mintJob.update({
                    where: { id: mintJobId },
                    data: { status: 'failed', errorCode: 'SIGNER_WALLET_MISMATCH' },
                });
                return { ok: false, error: 'SIGNER_WALLET_MISMATCH' };
            }
        }

        const provider = new JsonRpcProvider(rpc);
        let pendingNonce: number;
        try {
            pendingNonce = await this.nonce.getPendingNonce(provider, addr);
        } catch (e: unknown) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'NONCE_RPC_ERROR' },
            });
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }

        const lock = await this.nonce.acquireLockTx({
            chainId: job.chainId,
            walletAddress: addr,
            nonce: String(pendingNonce),
            mintJobId,
        });
        if (!lock.ok) {
            const lockCode =
                job.chainId === 1 && lock.code === 'NONCE_LOCK_CONFLICT' ? 'MAINNET_NONCE_LOCK_REQUIRED' : lock.code;
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: lockCode },
            });
            return { ok: false, error: lockCode };
        }

        const emergencySign = await getEffectiveEmergencyStop(this.prisma);
        if (job.chainId === 1 && (emergencySign || mintEnv.MINT_EMERGENCY_STOP)) {
            await this.nonce.finalizeLock(mintJobId, 'failed');
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: 'MAINNET_EMERGENCY_STOP_ACTIVE' },
            });
            return { ok: false, error: 'MAINNET_EMERGENCY_STOP_ACTIVE' };
        }

        if (job.chainId === 1 && approvalCtxLive) {
            const aSign = await findActiveMainnetApproval(this.prisma, {
                userId: job.userId,
                guildId: job.guildId,
                mintWalletId: job.walletId,
            });
            const eSign = validateMainnetApprovalForLive(aSign, approvalCtxLive);
            if (eSign) {
                await this.nonce.finalizeLock(mintJobId, 'failed');
                await this.prisma.mintJob.update({
                    where: { id: mintJobId },
                    data: { status: 'blocked', errorCode: eSign },
                });
                return { ok: false, error: eSign };
            }
            const pge = validatePlanGasAgainstApproval(mat.plan, aSign!);
            if (pge) {
                await this.nonce.finalizeLock(mintJobId, 'failed');
                await this.prisma.mintJob.update({
                    where: { id: mintJobId },
                    data: { status: 'blocked', errorCode: pge },
                });
                return { ok: false, error: pge };
            }
        }

        await this.prisma.mintJob.update({
            where: { id: mintJobId },
            data: {
                status: 'nonce_locked',
                planHash: mat.planHash,
                simulationStatus: 'PASS',
                maxFeePerGas: mat.plan.maxFeePerGas.toString(10),
                maxPriorityFeePerGas: mat.plan.maxPriorityFeePerGas.toString(10),
                maxTotalCostNative: mintEnv.MINT_MAX_TOTAL_COST_NATIVE || undefined,
            },
        });

        const unsignedWithNonce: UnsignedTx = { ...mat.unsigned, nonce: pendingNonce };
        const mode = this.signer.resolveMode();
        const signRes = await this.signer.signApprovedPlan({
            planHash: mat.planHash,
            approvedPlanHash: mat.planHash,
            mode,
            unsigned: unsignedWithNonce,
            chainId: job.chainId,
            emergencyStopActive: emergencySign,
            jobId: mintJobId,
            walletAddress: addr,
            planWalletAddress: mat.plan.walletAddress.toLowerCase(),
            calldataHash: keccak256(unsignedWithNonce.data),
            maxTotalCostNativeWei: mat.plan.maxTotalCostNativeWei,
        });

        if (!signRes.ok) {
            await this.nonce.finalizeLock(mintJobId, 'failed');
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: signRes.code, errorMessage: signRes.message },
            });
            return { ok: false, error: signRes.code };
        }

        const mtRow = await this.prisma.mintTransaction.create({
            data: {
                mintJobId,
                chainId: job.chainId,
                walletAddress: addr,
                nonce: String(pendingNonce),
                to: unsignedWithNonce.to.toLowerCase(),
                value: unsignedWithNonce.value.toString(10),
                calldataHash: keccak256(unsignedWithNonce.data),
                txHash: null,
                status: 'submitted',
                providerResponsesJson: {},
                submittedAt: new Date(),
            },
        });

        await this.prisma.mintJob.update({
            where: { id: mintJobId },
            data: {
                status: 'submitted',
                executionStartedAt: new Date(),
                submittedAt: new Date(),
                metadataJson: {
                    signingOccurred: true,
                    broadcastOccurred: true,
                    signerMode: mode,
                } as object,
            },
        });

        await this.audit.log({
            mintJobId,
            guildId: job.guildId,
            userId: job.userId,
            action: 'broadcast_attempt',
            status: 'submitted',
            message: 'Sending raw tx',
        });

        const emergencyBcast = await getEffectiveEmergencyStop(this.prisma);
        if (job.chainId === 1 && (emergencyBcast || mintEnv.MINT_EMERGENCY_STOP)) {
            await this.nonce.finalizeLock(mintJobId, 'failed');
            await this.prisma.mintTransaction.update({
                where: { id: mtRow.id },
                data: {
                    status: 'failed',
                    providerResponsesJson: { reason: 'MAINNET_EMERGENCY_STOP_ACTIVE' } as object,
                },
            });
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'MAINNET_EMERGENCY_STOP_ACTIVE' },
            });
            return { ok: false, error: 'MAINNET_EMERGENCY_STOP_ACTIVE' };
        }
        if (job.chainId === 1 && approvalCtxLive) {
            const aBc = await findActiveMainnetApproval(this.prisma, {
                userId: job.userId,
                guildId: job.guildId,
                mintWalletId: job.walletId,
            });
            const eBc = validateMainnetApprovalForLive(aBc, approvalCtxLive);
            if (eBc) {
                await this.nonce.finalizeLock(mintJobId, 'failed');
                await this.prisma.mintTransaction.update({
                    where: { id: mtRow.id },
                    data: { status: 'failed', providerResponsesJson: { reason: eBc } as object },
                });
                await this.prisma.mintJob.update({
                    where: { id: mintJobId },
                    data: { status: 'failed', errorCode: eBc },
                });
                return { ok: false, error: eBc };
            }
            const pGb = validatePlanGasAgainstApproval(mat.plan, aBc!);
            if (pGb) {
                await this.nonce.finalizeLock(mintJobId, 'failed');
                await this.prisma.mintTransaction.update({
                    where: { id: mtRow.id },
                    data: { status: 'failed', providerResponsesJson: { reason: pGb } as object },
                });
                await this.prisma.mintJob.update({
                    where: { id: mintJobId },
                    data: { status: 'failed', errorCode: pGb },
                });
                return { ok: false, error: pGb };
            }
        }

        const bcast = await this.broadcast.broadcastRaw({
            rawTransaction: signRes.rawTransaction,
            urls: [rpc],
            emergencyStopActive: emergencyBcast,
        });
        const firstOk = bcast.find((r) => r.ok && r.response);
        if (!firstOk?.response) {
            await this.nonce.finalizeLock(mintJobId, 'failed');
            await this.prisma.mintTransaction.update({
                where: { id: mtRow.id },
                data: {
                    status: 'failed',
                    providerResponsesJson: { broadcasts: bcast } as object,
                },
            });
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'BROADCAST_FAILED' },
            });
            return { ok: false, error: 'BROADCAST_FAILED' };
        }

        const txHash = firstOk.response;
        await this.prisma.mintTransaction.update({
            where: { id: mtRow.id },
            data: { txHash, providerResponsesJson: { broadcasts: bcast } as object },
        });
        await this.prisma.mintJob.update({
            where: { id: mintJobId },
            data: { txHash, status: 'pending_confirmation' },
        });

        const tracker = new ResultTracker(this.prisma);
        const waited = await tracker.pollReceipt({
            rpcUrl: rpc,
            txHash,
            timeoutMs: 180_000,
            pollMs: 3000,
        });

        if (!waited.receipt) {
            await this.nonce.finalizeLock(mintJobId, 'failed');
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'RECEIPT_TIMEOUT' },
            });
            return { ok: false, error: 'RECEIPT_TIMEOUT', txHash };
        }

        await tracker.applyReceiptToMintRecords({
            mintJobId,
            mintTransactionId: mtRow.id,
            receipt: waited.receipt,
            txHash,
        });

        const st = waited.receipt.status;
        const success = Number(st) === 1;

        await this.nonce.finalizeLock(mintJobId, success ? 'confirmed' : 'failed');

        await this.audit.log({
            mintJobId,
            guildId: job.guildId,
            userId: job.userId,
            action: 'live_complete',
            status: success ? 'confirmed' : 'reverted',
            message: txHash,
        });

        return { ok: success, txHash, error: success ? undefined : 'TX_REVERTED' };
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
