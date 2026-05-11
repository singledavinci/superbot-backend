import { mintEnv, isLiveEngineMode } from '../config/mintEnv';
import type { UnsignedTx } from './TransactionBuilder';

export type SignerMode = 'simulation-only' | 'external-signer' | 'vault-signer' | 'local-dev-signer';

export class SignerAdapter {
    signerConfigured(): boolean {
        return !!(process.env.MINT_EXTERNAL_SIGNER_URL || process.env.MINT_VAULT_SIGNER_URL);
    }

    async signApprovedPlan(args: {
        planHash: string;
        approvedPlanHash: string;
        mode: SignerMode;
        unsigned: UnsignedTx;
        chainId: number;
    }): Promise<{ ok: true; rawTransaction: string } | { ok: false; code: string; message: string }> {
        if (mintEnv.MINT_EMERGENCY_STOP) {
            return { ok: false, code: 'EXECUTION_EMERGENCY_STOP', message: 'Emergency stop enabled' };
        }
        if (!isLiveEngineMode()) {
            return { ok: false, code: 'EXECUTION_DISABLED', message: 'Not in live engine mode' };
        }
        if (args.planHash !== args.approvedPlanHash) {
            return { ok: false, code: 'PLAN_HASH_MISMATCH', message: 'Plan changed after approval' };
        }
        if (args.mode === 'simulation-only') {
            return { ok: false, code: 'SIGNER_SIMULATION_ONLY', message: 'No signing in simulation-only' };
        }
        if (args.mode === 'local-dev-signer') {
            if (process.env.NODE_ENV === 'production' || !mintEnv.MINT_TESTNET_ONLY) {
                return { ok: false, code: 'SIGNER_FORBIDDEN', message: 'local-dev-signer not allowed' };
            }
            try {
                const { Wallet } = await import('ethers');
                const pk = process.env.MINT_LOCAL_DEV_PRIVATE_KEY;
                if (!pk) return { ok: false, code: 'SIGNER_NOT_CONFIGURED', message: 'MINT_LOCAL_DEV_PRIVATE_KEY missing' };
                const w = new Wallet(pk);
                const tx = await w.populateTransaction({
                    chainId: args.unsigned.chainId,
                    to: args.unsigned.to,
                    data: args.unsigned.data,
                    value: args.unsigned.value,
                    gasLimit: args.unsigned.gasLimit,
                    maxFeePerGas: args.unsigned.maxFeePerGas,
                    maxPriorityFeePerGas: args.unsigned.maxPriorityFeePerGas,
                    nonce: args.unsigned.nonce,
                });
                const signed = await w.signTransaction(tx);
                return { ok: true, rawTransaction: signed };
            } catch (e: unknown) {
                return { ok: false, code: 'SIGNER_REFUSED', message: e instanceof Error ? e.message : String(e) };
            }
        }
        return { ok: false, code: 'SIGNER_NOT_CONFIGURED', message: 'Use external-signer or local-dev-signer for v1' };
    }
}
