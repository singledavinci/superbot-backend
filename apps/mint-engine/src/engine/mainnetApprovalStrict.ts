import type { MainnetLiveBlockCode } from './mainnetLivePolicy';
import type { MainnetApprovalRow } from './mainnetApprovalQueries';
import type { MintPlan } from './TransactionPlanner';

export type LiveJobApprovalContext = {
    guildId: string;
    userId: string;
    mintWalletId: string;
    walletAddressLower: string;
    chainId: number;
    quantity: number;
    collectionLower: string;
};

/**
 * Validates an active approval row against the live job identity, caps, expiry, and collection allow-list.
 * Call again immediately before sign and before broadcast.
 */
export function validateMainnetApprovalForLive(
    approval: MainnetApprovalRow | null,
    job: LiveJobApprovalContext,
    now: Date = new Date(),
): MainnetLiveBlockCode | null {
    if (!approval) return 'MAINNET_WALLET_NOT_APPROVED';
    if (approval.approvalStatus !== 'active') return 'MAINNET_WALLET_NOT_APPROVED';
    if (approval.expiresAt <= now) return 'MAINNET_APPROVAL_EXPIRED';
    if (approval.guildId !== job.guildId) return 'MAINNET_WALLET_NOT_APPROVED';
    if (approval.userId !== job.userId) return 'MAINNET_WALLET_NOT_APPROVED';
    if (approval.mintWalletId !== job.mintWalletId) return 'MAINNET_WALLET_NOT_APPROVED';
    if (approval.walletAddress.toLowerCase() !== job.walletAddressLower) return 'MAINNET_WALLET_NOT_APPROVED';
    if (approval.chainId !== job.chainId) return 'MAINNET_WALLET_NOT_APPROVED';

    const mf = (approval.maxFeePerGas || '').trim();
    const mp = (approval.maxPriorityFeePerGas || '').trim();
    const mt = (approval.maxTotalCostNative || '').trim();
    if (!mf || !mp || !mt) return 'MAINNET_COST_CAP_REQUIRED';

    if (job.quantity > approval.maxQuantity) return 'MAINNET_QUANTITY_CAP_EXCEEDED';

    const allowed = approval.allowedCollections;
    if (allowed != null && Array.isArray(allowed) && allowed.length > 0) {
        const list = allowed.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
        if (!list.includes(job.collectionLower)) return 'MAINNET_COLLECTION_NOT_ALLOWED';
    }

    return null;
}

/** Plan gas and spend must not exceed approval caps (wei strings on approval row). */
export function validatePlanGasAgainstApproval(plan: MintPlan, approval: MainnetApprovalRow): MainnetLiveBlockCode | null {
    const mf = (approval.maxFeePerGas || '').trim();
    const mp = (approval.maxPriorityFeePerGas || '').trim();
    const mt = (approval.maxTotalCostNative || '').trim();
    if (!mf || !mp || !mt) return 'MAINNET_GAS_CAP_REQUIRED';
    try {
        const capMax = BigInt(mf);
        const capTip = BigInt(mp);
        const capTotal = BigInt(mt);
        if (plan.maxFeePerGas > capMax || plan.maxPriorityFeePerGas > capTip) return 'MAINNET_GAS_CAP_REQUIRED';
        const value = BigInt(plan.valueWei);
        const gasMax = plan.gasLimit * plan.maxFeePerGas;
        if (value + gasMax > capTotal) return 'MAINNET_COST_CAP_REQUIRED';
    } catch {
        return 'MAINNET_GAS_CAP_REQUIRED';
    }
    return null;
}
