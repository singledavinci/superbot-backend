import { ZeroAddress } from 'ethers';
import type { MintPlan } from './TransactionPlanner';
import { SEA_DROP_IFACE } from './seaDropAbi';

export interface UnsignedTx {
    chainId: number;
    to: string;
    data: `0x${string}`;
    value: bigint;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    nonce?: number;
}

const _iface = SEA_DROP_IFACE;

export class TransactionBuilder {
    /** Preloaded interface — no network ABI fetch at mint time. */
    static encodeMintPublicCalldata(args: {
        nftContract: string;
        feeRecipient: string;
        minterIfNotPayer: string;
        quantity: bigint;
    }): `0x${string}` {
        return _iface.encodeFunctionData('mintPublic', [
            args.nftContract,
            args.feeRecipient,
            args.minterIfNotPayer,
            args.quantity,
        ]) as `0x${string}`;
    }

    buildUnsigned(plan: MintPlan): UnsignedTx {
        if (!plan.calldata || plan.calldata === '0x') {
            throw new Error('PLAN_MISSING_CALLDATA');
        }
        return {
            chainId: plan.chainId,
            to: plan.to,
            data: plan.calldata,
            value: BigInt(plan.valueWei),
            gasLimit: plan.gasLimit,
            maxFeePerGas: plan.maxFeePerGas,
            maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
        };
    }

    buildPreparePayload(plan: MintPlan): Record<string, unknown> {
        const unsigned = this.buildUnsigned(plan);
        return {
            kind: 'unsigned_eip1559_tx',
            chainId: unsigned.chainId,
            to: unsigned.to,
            data: unsigned.data,
            value: unsigned.value.toString(10),
            gasLimit: unsigned.gasLimit.toString(10),
            maxFeePerGas: unsigned.maxFeePerGas.toString(10),
            maxPriorityFeePerGas: unsigned.maxPriorityFeePerGas.toString(10),
            mintFunction: plan.mintFunction,
            nftContract: plan.nftContract,
        };
    }
}

export function defaultFeeRecipient(dropFeeRecipient: string | null): string {
    if (dropFeeRecipient && dropFeeRecipient.toLowerCase() !== ZeroAddress.toLowerCase()) {
        return dropFeeRecipient;
    }
    return ZeroAddress;
}
