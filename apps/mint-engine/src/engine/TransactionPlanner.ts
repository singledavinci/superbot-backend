import { createHash } from 'crypto';
import { ZeroAddress } from 'ethers';
import type { ResolvedDrop } from './mintTypes';
import { canonicalStringify } from './canonicalJson';
import { TransactionBuilder, defaultFeeRecipient } from './TransactionBuilder';

export type ExecutionMode = 'simulation' | 'prepare' | 'live' | 'mainnet_dry_run';

export interface MintPlan {
    chainId: number;
    executionMode: ExecutionMode;
    walletAddress: string;
    nftContract: string;
    seaDropContract: string;
    /** Transaction `to` — SeaDrop contract. */
    to: string;
    dropSource: string;
    dropType: string;
    quantity: number;
    /** Total native value in wei (decimal string). */
    valueWei: string;
    calldata: `0x${string}`;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    maxTotalCostNativeWei: string | null;
    startTime: number | null;
    expiryTime: number | null;
    simulationRequired: boolean;
    broadcastStrategy: string;
    mintFunction: 'mintPublic' | null;
}

export type PlanBuildResult =
    | { ok: true; plan: MintPlan; planHash: string }
    | { ok: false; code: string; message: string };

function hashPlan(plan: MintPlan): string {
    const canonical = canonicalStringify({
        broadcastStrategy: plan.broadcastStrategy,
        calldata: plan.calldata,
        chainId: plan.chainId,
        dropSource: plan.dropSource,
        dropType: plan.dropType,
        executionMode: plan.executionMode,
        expiryTime: plan.expiryTime,
        gasLimit: plan.gasLimit.toString(10),
        maxFeePerGas: plan.maxFeePerGas.toString(10),
        maxPriorityFeePerGas: plan.maxPriorityFeePerGas.toString(10),
        maxTotalCostNativeWei: plan.maxTotalCostNativeWei,
        mintContract: plan.seaDropContract,
        mintFunction: plan.mintFunction,
        nftContract: plan.nftContract,
        quantity: plan.quantity,
        seaDropContract: plan.seaDropContract,
        simulationRequired: plan.simulationRequired,
        startTime: plan.startTime,
        to: plan.to,
        valueWei: plan.valueWei,
        walletAddress: plan.walletAddress,
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export class TransactionPlanner {
    buildPlan(args: {
        chainId: number;
        executionMode: ExecutionMode;
        drop: ResolvedDrop;
        walletAddress: string;
        quantity: number;
        maxFeePerGasWei?: bigint;
        maxPriorityFeePerGasWei?: bigint;
        gasLimit?: bigint;
        maxTotalCostNativeWei?: string | null;
    }): PlanBuildResult {
        if (args.chainId !== args.drop.chainId) {
            return { ok: false, code: 'WRONG_CHAIN', message: 'chainId does not match resolved drop' };
        }
        if (!Number.isFinite(args.quantity) || args.quantity < 1) {
            return { ok: false, code: 'INVALID_QUANTITY', message: 'quantity must be >= 1' };
        }
        if (args.drop.maxPerWallet != null && args.quantity > args.drop.maxPerWallet) {
            return { ok: false, code: 'INVALID_QUANTITY', message: 'quantity exceeds max per wallet' };
        }
        if (!args.drop.priceNative) {
            return { ok: false, code: 'FAIL_UNKNOWN_PRICE', message: 'Missing mint unit price (wei)' };
        }
        if (!args.drop.mintFunction || args.drop.mintFunction !== 'mintPublic') {
            return { ok: false, code: 'FAIL_UNKNOWN_FUNCTION', message: 'Unsupported mint function for planner' };
        }
        let unitPrice: bigint;
        try {
            unitPrice = BigInt(args.drop.priceNative);
        } catch {
            return { ok: false, code: 'FAIL_UNKNOWN_PRICE', message: 'priceNative is not a valid integer wei string' };
        }
        const qty = BigInt(args.quantity);
        const totalValue = unitPrice * qty;
        const feeRecipient = defaultFeeRecipient(args.drop.feeRecipient);
        let calldata: `0x${string}`;
        try {
            calldata = TransactionBuilder.encodeMintPublicCalldata({
                nftContract: args.drop.nftContract,
                feeRecipient,
                minterIfNotPayer: ZeroAddress,
                quantity: qty,
            });
        } catch (e: unknown) {
            return {
                ok: false,
                code: 'FAIL_UNKNOWN_FUNCTION',
                message: e instanceof Error ? e.message : String(e),
            };
        }

        const mode: ExecutionMode =
            args.executionMode === 'mainnet_dry_run'
                ? 'live'
                : args.executionMode === 'prepare' || args.executionMode === 'live' || args.executionMode === 'simulation'
                  ? args.executionMode
                  : 'simulation';

        const plan: MintPlan = {
            chainId: args.chainId,
            executionMode: mode,
            walletAddress: args.walletAddress.toLowerCase(),
            nftContract: args.drop.nftContract.toLowerCase(),
            seaDropContract: args.drop.seaDropContract.toLowerCase(),
            to: args.drop.seaDropContract.toLowerCase(),
            dropSource: args.drop.source,
            dropType: args.drop.dropType,
            quantity: args.quantity,
            valueWei: totalValue.toString(10),
            calldata,
            gasLimit: args.gasLimit ?? 350_000n,
            maxFeePerGas: args.maxFeePerGasWei ?? 0n,
            maxPriorityFeePerGas: args.maxPriorityFeePerGasWei ?? 0n,
            maxTotalCostNativeWei: args.maxTotalCostNativeWei ?? null,
            startTime: args.drop.startTime,
            expiryTime: args.drop.endTime,
            simulationRequired: true,
            broadcastStrategy: 'multi_rpc',
            mintFunction: 'mintPublic',
        };

        return { ok: true, plan, planHash: hashPlan(plan) };
    }
}
