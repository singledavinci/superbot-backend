import type { PrismaClient } from '@superbot/database';
import { JsonRpcProvider, keccak256 } from 'ethers';
import { mintEnv, isLiveEngineMode, mintGasCapsConfigured } from '../config/mintEnv';
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
            if (!mintEnv.MINT_EXECUTION_ENABLED || !isLiveEngineMode()) {
                return {
                    error: 'LIVE_EXECUTION_DISABLED',
                    message: 'Set MINT_EXECUTION_ENABLED=true and MINT_ENGINE_MODE=live for live jobs',
                };
            }
            if (args.chainId === 1) {
                return { error: 'MAINNET_DISABLED', message: 'Mainnet live jobs are blocked' };
            }
            if (mintEnv.MINT_TESTNET_ONLY && args.chainId !== mintEnv.MINT_DEFAULT_CHAIN_ID) {
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
            where: { userId: user.id, address: args.walletAddress.toLowerCase(), chainId: args.chainId },
        });
        if (!wallet) return { error: 'MINT_WALLET_NOT_FOUND' };
        const authAction = args.executionMode === 'live' ? 'live' : 'schedule';
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

    private async checkProviderHealthyForLive(): Promise<boolean> {
        if (!this.rpcUrl) return false;
        try {
            const p = new JsonRpcProvider(this.rpcUrl);
            await p.getBlockNumber();
            return true;
        } catch {
            return false;
        }
    }

    /** Resolve drop + plan + unsigned tx (simulation expects missing nonce in unsigned for eth_call). */
    private async materializeUnsignedForJob(job: {
        chainId: number;
        collectionAddress: string;
        mintContract: string;
        dropSource: string;
        quantity: number;
        walletAddress: string;
    }): Promise<
        | {
              ok: true;
              plan: MintPlan;
              planHash: string;
              unsigned: UnsignedTx;
              dropStartMs: number | null;
          }
        | { ok: false; code: string; message: string }
    > {
        if (!this.rpcUrl) return { ok: false, code: 'NO_RPC', message: 'HTTPS RPC not configured' };
        const dropRes = await this.dropResolver.resolve({
            chainId: job.chainId,
            collectionAddress: job.collectionAddress,
            mintContract: job.mintContract,
            dropSource: job.dropSource,
            rpcUrl: this.rpcUrl,
        });
        if (!dropRes.ok) return { ok: false, code: dropRes.code, message: dropRes.message };
        if (dropRes.drop.requiresProof || dropRes.drop.requiresSignature) {
            return { ok: false, code: 'FAIL_MISSING_PROOF', message: 'Drop requires proof or signature' };
        }
        const gasEngine = new GasEngine(this.rpcUrl);
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
     * Sepolia/testnet live path: simulate → policy → nonce lock → sign → broadcast → receipt.
     * Does not run on mainnet (policy + BroadcastEngine guard).
     */
    async executeLiveMintJob(mintJobId: string): Promise<{ ok: boolean; error?: string; txHash?: string }> {
        if (!this.rpcUrl) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'failed', errorCode: 'NO_RPC' },
            });
            return { ok: false, error: 'NO_RPC' };
        }

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

        const addr = job.wallet.address.toLowerCase();
        const mat = await this.materializeUnsignedForJob({
            chainId: job.chainId,
            collectionAddress: job.collectionAddress,
            mintContract: job.mintContract,
            dropSource: job.dropSource,
            quantity: job.quantity,
            walletAddress: addr,
        });
        if (!mat.ok) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'preflight_failed', errorCode: mat.code },
            });
            return { ok: false, error: mat.code };
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

        const sim = new SimulationEngine(this.rpcUrl);
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
        const gasEngine = new GasEngine(this.rpcUrl);
        const costOk = gasEngine.validatePlanTotalCost(mat.plan);
        if (!costOk.ok) {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: 'BLOCK_GAS_CAP', errorMessage: costOk.message },
            });
            return { ok: false, error: costOk.message };
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
            providerHealthy: await this.checkProviderHealthyForLive(),
        });

        if (liveDecision !== 'ALLOW_LIVE_EXECUTION') {
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: liveDecision },
            });
            await this.audit.log({
                mintJobId,
                guildId: job.guildId,
                userId: job.userId,
                action: 'live_blocked',
                status: liveDecision,
                message: 'policy blocked live execution',
            });
            return { ok: false, error: liveDecision };
        }

        const modeEarly = this.signer.resolveMode();
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

        const provider = new JsonRpcProvider(this.rpcUrl);
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
            await this.prisma.mintJob.update({
                where: { id: mintJobId },
                data: { status: 'blocked', errorCode: lock.code },
            });
            return { ok: false, error: lock.code };
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

        const bcast = await this.broadcast.broadcastRaw({
            rawTransaction: signRes.rawTransaction,
            urls: [this.rpcUrl],
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
            rpcUrl: this.rpcUrl,
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
