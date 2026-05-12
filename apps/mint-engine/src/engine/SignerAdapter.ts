import crypto from 'crypto';
import { mintEnv, isLiveEngineMode } from '../config/mintEnv';
import type { UnsignedTx } from './TransactionBuilder';
import { isMainnetChain } from './mainnetGuard';

export type SignerMode = 'simulation-only' | 'external-signer' | 'vault-signer' | 'local-dev-signer';

export class SignerAdapter {
    /** True when local dev key allowed AND present, external URL, or vault URL. */
    signerConfigured(): boolean {
        if (!!process.env.MINT_EXTERNAL_SIGNER_URL?.trim()) return true;
        if (!!process.env.MINT_VAULT_SIGNER_URL?.trim()) return true;
        if (!!process.env.MINT_LOCAL_DEV_PRIVATE_KEY?.trim() && this.localDevSignerAllowed()) return true;
        return false;
    }

    /** Allow local-dev on Railway production when MINT_TESTNET_ONLY=true (NODE_ENV !== production OR testnet-only). */
    localDevSignerAllowed(): boolean {
        return mintEnv.MINT_TESTNET_ONLY || process.env.NODE_ENV !== 'production';
    }

    resolveMode(): SignerMode {
        if (process.env.MINT_EXTERNAL_SIGNER_URL?.trim()) return 'external-signer';
        if (process.env.MINT_VAULT_SIGNER_URL?.trim()) return 'vault-signer';
        if (process.env.MINT_LOCAL_DEV_PRIVATE_KEY?.trim()) return 'local-dev-signer';
        return 'simulation-only';
    }

    async signApprovedPlan(args: {
        planHash: string;
        approvedPlanHash: string;
        mode: SignerMode;
        unsigned: UnsignedTx;
        chainId: number;
        /** DB/runtime emergency OR env (caller should pass effective value). */
        emergencyStopActive?: boolean;
    }): Promise<{ ok: true; rawTransaction: string } | { ok: false; code: string; message: string }> {
        if (mintEnv.MINT_EMERGENCY_STOP || args.emergencyStopActive) {
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
            if (isMainnetChain(args.chainId) && !mintEnv.MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED) {
                return { ok: false, code: 'MAINNET_SIGNER_NOT_APPROVED', message: 'local-dev mainnet requires MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED=true' };
            }
            if (!this.localDevSignerAllowed()) {
                return { ok: false, code: 'SIGNER_FORBIDDEN', message: 'local-dev-signer not allowed in this environment' };
            }
            try {
                const { Wallet } = await import('ethers');
                const pk = process.env.MINT_LOCAL_DEV_PRIVATE_KEY?.trim();
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

        if (args.mode === 'external-signer') {
            if (args.chainId === 1 && !mintEnv.MINT_MAINNET_SIGNER_APPROVED) {
                return { ok: false, code: 'MAINNET_SIGNER_NOT_APPROVED', message: 'Set MINT_MAINNET_SIGNER_APPROVED=true for mainnet external signer' };
            }
            const url = process.env.MINT_EXTERNAL_SIGNER_URL?.trim();
            if (!url) return { ok: false, code: 'SIGNER_NOT_CONFIGURED', message: 'MINT_EXTERNAL_SIGNER_URL missing' };
            if (!mintEnv.MINT_ENGINE_SERVICE_SECRET) {
                return { ok: false, code: 'SIGNER_NOT_CONFIGURED', message: 'MINT_ENGINE_SERVICE_SECRET required for external signer HMAC' };
            }
            const payload = {
                planHash: args.planHash,
                chainId: args.chainId,
                unsigned: {
                    chainId: args.unsigned.chainId,
                    to: args.unsigned.to,
                    data: args.unsigned.data,
                    value: args.unsigned.value.toString(10),
                    gasLimit: args.unsigned.gasLimit.toString(10),
                    maxFeePerGas: args.unsigned.maxFeePerGas.toString(10),
                    maxPriorityFeePerGas: args.unsigned.maxPriorityFeePerGas.toString(10),
                    nonce: args.unsigned.nonce,
                },
            };
            const body = JSON.stringify(payload);
            const sig = crypto.createHmac('sha256', mintEnv.MINT_ENGINE_SERVICE_SECRET).update(body).digest('hex');
            try {
                const ac = new AbortController();
                const t = setTimeout(() => ac.abort(), 45_000);
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Mint-Signature': sig,
                        'X-Mint-Plan-Hash': args.planHash,
                    },
                    body,
                    signal: ac.signal,
                });
                clearTimeout(t);
                if (!res.ok) {
                    const txt = await res.text().catch(() => '');
                    return { ok: false, code: 'SIGNER_HTTP_ERROR', message: txt.slice(0, 500) || String(res.status) };
                }
                const j = (await res.json()) as { rawTransaction?: string };
                if (typeof j.rawTransaction !== 'string' || !j.rawTransaction.startsWith('0x')) {
                    return { ok: false, code: 'SIGNER_BAD_PAYLOAD', message: 'Response missing rawTransaction' };
                }
                return { ok: true, rawTransaction: j.rawTransaction };
            } catch (e: unknown) {
                return { ok: false, code: 'SIGNER_REFUSED', message: e instanceof Error ? e.message : String(e) };
            }
        }

        if (args.mode === 'vault-signer') {
            return { ok: false, code: 'SIGNER_NOT_CONFIGURED', message: 'vault-signer not implemented in this build' };
        }

        return { ok: false, code: 'SIGNER_NOT_CONFIGURED', message: 'Unsupported signer mode' };
    }
}
