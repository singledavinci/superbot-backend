import crypto from 'crypto';
import { Wallet } from 'ethers';
import { mintEnv, isLiveEngineMode } from '../config/mintEnv';
import type { UnsignedTx } from './TransactionBuilder';
import { isMainnetChain } from './mainnetGuard';

const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function isValidEthAddress0x(a: string): boolean {
    return ETH_ADDR_RE.test(a.trim());
}

export type SignerMode = 'simulation-only' | 'external-signer' | 'vault-signer' | 'local-dev-signer';

/** Mask `0x` + 20-byte hex for public status (never logs raw input). */
export function maskEthereumAddress(addr: string): string | null {
    const a = addr.trim().toLowerCase();
    if (!a.startsWith('0x') || a.length < 10) return null;
    return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function engineServiceSecretTrimmed(): string {
    return String(process.env.MINT_ENGINE_SERVICE_SECRET || '')
        .replace(/^\uFEFF/, '')
        .trim();
}

/** Live read — do not use cached `mintEnv` snapshot for operator address binding. */
function mintSignerAddressFromEnv(): string {
    return String(process.env.MINT_SIGNER_ADDRESS || '').replace(/^\uFEFF/, '').trim().toLowerCase();
}

export class SignerAdapter {
    /** External signer is "known" only with a valid `0x` + 20-byte address in env (never a secret). */
    private externalSignerAddressReady(): boolean {
        return isValidEthAddress0x(mintSignerAddressFromEnv());
    }

    /**
     * True when a **supported** signing backend is configured:
     * - **external-signer**: `MINT_EXTERNAL_SIGNER_URL` + `MINT_ENGINE_SERVICE_SECRET` + valid `MINT_SIGNER_ADDRESS` (HMAC to callback)
     * - **local-dev-signer**: `MINT_LOCAL_DEV_PRIVATE_KEY` only when `localDevSignerAllowed()`; if `MINT_SIGNER_ADDRESS` is set it must match the wallet derived from the dev key
     * **vault-signer** is **not** implemented — `MINT_VAULT_SIGNER_URL` alone does **not** make this true.
     */
    signerConfigured(): boolean {
        if (process.env.MINT_EXTERNAL_SIGNER_URL?.trim()) {
            if (!engineServiceSecretTrimmed()) return false;
            return this.externalSignerAddressReady();
        }
        if (process.env.MINT_VAULT_SIGNER_URL?.trim()) return false;
        if (process.env.MINT_LOCAL_DEV_PRIVATE_KEY?.trim() && this.localDevSignerAllowed()) {
            const pk = process.env.MINT_LOCAL_DEV_PRIVATE_KEY.trim();
            if (mintSignerAddressFromEnv()) {
                if (!this.externalSignerAddressReady()) return false;
                try {
                    const w = new Wallet(pk);
                    return w.address.toLowerCase() === mintSignerAddressFromEnv();
                } catch {
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    /** Allow local-dev on Railway production when `MINT_TESTNET_ONLY=true` (NODE_ENV !== production OR testnet-only). */
    localDevSignerAllowed(): boolean {
        return mintEnv.MINT_TESTNET_ONLY || process.env.NODE_ENV !== 'production';
    }

    resolveMode(): SignerMode {
        if (process.env.MINT_EXTERNAL_SIGNER_URL?.trim()) return 'external-signer';
        if (process.env.MINT_VAULT_SIGNER_URL?.trim()) return 'vault-signer';
        if (process.env.MINT_LOCAL_DEV_PRIVATE_KEY?.trim()) return 'local-dev-signer';
        return 'simulation-only';
    }

    /** Same semantics as `POST /v1/mint/status` `signerMainnetApproved`. */
    signerMainnetApproved(): boolean {
        const mode = this.resolveMode();
        return (
            mintEnv.MINT_MAINNET_SIGNER_APPROVED ||
            (mode === 'local-dev-signer' && mintEnv.MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED)
        );
    }

    /**
     * Public-safe masked address: prefers `MINT_SIGNER_ADDRESS`; for **local-dev** only, derives from env key in-memory (never logged).
     */
    signerAddressMasked(): string | null {
        const fromEnv = mintSignerAddressFromEnv();
        if (fromEnv && isValidEthAddress0x(fromEnv)) return maskEthereumAddress(fromEnv);
        if (this.resolveMode() === 'local-dev-signer' && this.localDevSignerAllowed()) {
            const pk = process.env.MINT_LOCAL_DEV_PRIVATE_KEY?.trim();
            if (!pk) return null;
            try {
                return maskEthereumAddress(new Wallet(pk).address.toLowerCase());
            } catch {
                return null;
            }
        }
        return null;
    }

    /**
     * Machine-readable reason when signing is not fully available, or external env is incomplete.
     * `null` when the active signer path is configured (external complete, or local-dev allowed, etc.).
     */
    signerBlockReason(): string | null {
        if (process.env.MINT_EXTERNAL_SIGNER_URL?.trim()) {
            if (!engineServiceSecretTrimmed()) return 'EXTERNAL_SIGNER_HMAC_SECRET_MISSING';
            if (!this.externalSignerAddressReady()) return 'SIGNER_ADDRESS_NOT_CONFIGURED';
            return null;
        }
        if (process.env.MINT_VAULT_SIGNER_URL?.trim()) return 'VAULT_SIGNER_NOT_IMPLEMENTED';
        if (!this.signerConfigured()) return 'SIGNER_NOT_CONFIGURED';
        return null;
    }

    async signApprovedPlan(args: {
        planHash: string;
        approvedPlanHash: string;
        mode: SignerMode;
        unsigned: UnsignedTx;
        chainId: number;
        /** DB/runtime emergency OR env (caller should pass effective value). */
        emergencyStopActive?: boolean;
        /** Execution correlation + external-signer verification (optional but set by live engine). */
        jobId?: string;
        walletAddress?: string;
        planWalletAddress?: string;
        calldataHash?: string;
        maxTotalCostNativeWei?: string | null;
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
        if (args.unsigned.chainId !== args.chainId) {
            return { ok: false, code: 'CHAIN_ID_MISMATCH', message: 'Unsigned tx chainId does not match job chainId' };
        }
        const wa = args.walletAddress?.trim().toLowerCase();
        const pwa = args.planWalletAddress?.trim().toLowerCase();
        if (wa && pwa && wa !== pwa) {
            return { ok: false, code: 'WALLET_MISMATCH', message: 'Job wallet does not match plan walletAddress' };
        }
        if (args.mode === 'simulation-only') {
            return { ok: false, code: 'SIGNER_SIMULATION_ONLY', message: 'No signing in simulation-only' };
        }

        if (args.mode === 'local-dev-signer') {
            if (isMainnetChain(args.chainId) && !mintEnv.MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED) {
                return {
                    ok: false,
                    code: 'MAINNET_SIGNER_NOT_APPROVED',
                    message: 'local-dev mainnet requires MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED=true',
                };
            }
            if (!this.localDevSignerAllowed()) {
                return { ok: false, code: 'SIGNER_FORBIDDEN', message: 'local-dev-signer not allowed in this environment' };
            }
            try {
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
                return {
                    ok: false,
                    code: 'MAINNET_SIGNER_NOT_APPROVED',
                    message: 'Set MINT_MAINNET_SIGNER_APPROVED=true for mainnet external signer',
                };
            }
            const url = process.env.MINT_EXTERNAL_SIGNER_URL?.trim();
            if (!url) return { ok: false, code: 'SIGNER_NOT_CONFIGURED', message: 'MINT_EXTERNAL_SIGNER_URL missing' };
            const secret = engineServiceSecretTrimmed();
            if (!secret) {
                return { ok: false, code: 'SIGNER_NOT_CONFIGURED', message: 'MINT_ENGINE_SERVICE_SECRET required for external signer HMAC' };
            }
            const payload: Record<string, unknown> = {
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
            if (args.jobId) payload.jobId = args.jobId;
            if (wa) payload.walletAddress = wa;
            if (args.calldataHash) payload.calldataHash = args.calldataHash;
            if (args.maxTotalCostNativeWei != null && args.maxTotalCostNativeWei !== '') {
                payload.maxTotalCostNativeWei = args.maxTotalCostNativeWei;
            }
            const body = JSON.stringify(payload);
            const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
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
