import { mintEnv, isLiveEngineMode, mintGasCapsConfigured, resolveMainnetRpcUrl } from '../config/mintEnv';

/** Explicit block codes for mainnet live (and shared dry-run / gate messaging). */
export type MainnetLiveBlockCode =
    | 'MAINNET_DRY_RUN_DISABLED'
    | 'MAINNET_DISABLED'
    | 'MAINNET_DRY_RUN_ONLY'
    | 'MAINNET_BETA_DISABLED'
    | 'MAINNET_WALLET_NOT_APPROVED'
    | 'MAINNET_APPROVAL_EXPIRED'
    | 'MAINNET_COLLECTION_NOT_ALLOWED'
    | 'MAINNET_SIGNER_NOT_APPROVED'
    | 'MAINNET_CONFIRMATION_REQUIRED'
    | 'MAINNET_COST_CAP_REQUIRED'
    | 'MAINNET_GAS_CAP_REQUIRED'
    | 'MAINNET_SIMULATION_REQUIRED'
    | 'MAINNET_PROVIDER_UNHEALTHY'
    | 'MAINNET_EMERGENCY_STOP_ACTIVE'
    | 'MAINNET_RPC_REQUIRED'
    | 'MAINNET_BETA_GUILD_MISMATCH'
    | 'MAINNET_BETA_USER_MISMATCH'
    | 'MAINNET_BETA_WALLET_MISMATCH'
    | 'MAINNET_BETA_QUANTITY'
    | 'MAINNET_BETA_CONCURRENT_JOB'
    | 'MAINNET_ACTIVE_JOB_LIMIT'
    | 'MAINNET_COPY_MINT_BLOCKED'
    | 'MAINNET_PRIVATE_RELAY_BLOCKED'
    | 'MAINNET_JOB_EXPIRED'
    | 'MAINNET_DROP_UNVERIFIED'
    | 'MAINNET_NONCE_LOCK_REQUIRED'
    | 'MAINNET_UNKNOWN_PRICE'
    | 'MAINNET_UNKNOWN_CALLDATA'
    | 'MAINNET_MISSING_PROOF'
    | 'MAINNET_QUANTITY_CAP_EXCEEDED';

export interface MainnetStrictInput {
    chainId: number;
    /** Live mainnet only; dry-run uses subset. */
    phase: 'live' | 'dry_run';
    emergencyStopActive: boolean;
    executionEnabled: boolean;
    engineModeLive: boolean;
    mainnetBroadcastEnabled: boolean;
    testnetOnly: boolean;
    mainnetBetaEnabled: boolean;
    requireSecureSigner: boolean;
    walletMainnetApproved: boolean;
    signerConfigured: boolean;
    signerMainnetApproved: boolean;
    simulationPass: boolean;
    gasCapsConfigured: boolean;
    maxTotalCostSet: boolean;
    maxFeePerGasSet: boolean;
    maxPriorityFeePerGasSet: boolean;
    providerHealthy: boolean;
    operatorConfirmationPresent: boolean;
    jobExpired: boolean;
    dropVerified: boolean;
    /** Beta caps */
    betaGuildOk: boolean;
    betaUserOk: boolean;
    betaWalletOk: boolean;
    quantityOk: boolean;
    concurrentJobsOk: boolean;
    copyMintDisabledOk: boolean;
    privateRelayDisabledOk: boolean;
}

export function evaluateMainnetStrict(i: MainnetStrictInput): MainnetLiveBlockCode | null {
    if (i.chainId !== 1) return null;

    if (i.phase === 'dry_run') {
        if (i.emergencyStopActive) return 'MAINNET_EMERGENCY_STOP_ACTIVE';
        if (!mintEnv.MINT_MAINNET_DRY_RUN) return 'MAINNET_DRY_RUN_DISABLED';
        if (!resolveMainnetRpcUrl()) return 'MAINNET_RPC_REQUIRED';
        if (!i.dropVerified) return 'MAINNET_DROP_UNVERIFIED';
        if (i.jobExpired) return 'MAINNET_JOB_EXPIRED';
        if (!i.providerHealthy) return 'MAINNET_PROVIDER_UNHEALTHY';
        if (!i.simulationPass) return 'MAINNET_SIMULATION_REQUIRED';
        if (!i.gasCapsConfigured) return 'MAINNET_GAS_CAP_REQUIRED';
        if (!i.maxTotalCostSet) return 'MAINNET_COST_CAP_REQUIRED';
        if (!i.maxFeePerGasSet || !i.maxPriorityFeePerGasSet) return 'MAINNET_GAS_CAP_REQUIRED';
        return null;
    }

    if (i.emergencyStopActive) return 'MAINNET_EMERGENCY_STOP_ACTIVE';

    if (!i.executionEnabled) return 'MAINNET_DISABLED';
    if (!i.engineModeLive) return 'MAINNET_DRY_RUN_ONLY';
    if (!i.mainnetBroadcastEnabled) return 'MAINNET_DISABLED';
    if (i.testnetOnly) return 'MAINNET_DISABLED';
    if (!i.mainnetBetaEnabled) return 'MAINNET_BETA_DISABLED';
    if (!i.requireSecureSigner) return 'MAINNET_SIGNER_NOT_APPROVED';
    if (!i.betaGuildOk) return 'MAINNET_BETA_GUILD_MISMATCH';
    if (!i.betaUserOk) return 'MAINNET_BETA_USER_MISMATCH';
    if (!i.betaWalletOk) return 'MAINNET_BETA_WALLET_MISMATCH';
    if (!i.quantityOk) return 'MAINNET_BETA_QUANTITY';
    if (!i.concurrentJobsOk) return 'MAINNET_ACTIVE_JOB_LIMIT';
    if (!i.copyMintDisabledOk) return 'MAINNET_COPY_MINT_BLOCKED';
    if (!i.privateRelayDisabledOk) return 'MAINNET_PRIVATE_RELAY_BLOCKED';
    if (!i.dropVerified) return 'MAINNET_DROP_UNVERIFIED';
    if (i.jobExpired) return 'MAINNET_JOB_EXPIRED';

    if (!resolveMainnetRpcUrl()) return 'MAINNET_RPC_REQUIRED';
    if (!i.walletMainnetApproved) return 'MAINNET_WALLET_NOT_APPROVED';
    if (!i.signerConfigured) return 'MAINNET_SIGNER_NOT_APPROVED';
    if (!i.signerMainnetApproved) return 'MAINNET_SIGNER_NOT_APPROVED';
    if (!i.simulationPass) return 'MAINNET_SIMULATION_REQUIRED';
    if (!i.gasCapsConfigured) return 'MAINNET_GAS_CAP_REQUIRED';
    if (!i.maxTotalCostSet) return 'MAINNET_COST_CAP_REQUIRED';
    if (!i.maxFeePerGasSet || !i.maxPriorityFeePerGasSet) return 'MAINNET_GAS_CAP_REQUIRED';
    if (!i.providerHealthy) return 'MAINNET_PROVIDER_UNHEALTHY';
    if (!i.operatorConfirmationPresent) return 'MAINNET_CONFIRMATION_REQUIRED';

    return null;
}

export function mainnetLiveEnvSatisfied(): boolean {
    return (
        mintEnv.MINT_EXECUTION_ENABLED &&
        isLiveEngineMode() &&
        mintEnv.MINT_MAINNET_BROADCAST_ENABLED &&
        !mintEnv.MINT_TESTNET_ONLY &&
        mintEnv.MINT_REQUIRE_SECURE_SIGNER &&
        mintEnv.MINT_MAINNET_BETA &&
        !mintEnv.MINT_EMERGENCY_STOP
    );
}
