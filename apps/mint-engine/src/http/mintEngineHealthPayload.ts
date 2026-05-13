import type { PrismaClient } from '@superbot/database';
import { mintEnv } from '../config/mintEnv';
import { SignerAdapter } from '../engine/SignerAdapter';

/** Public-safe JSON for GET /health/mint-engine (no secrets, URLs, or keys). */
export type MintEngineHealthPublicJson = {
    /** Bump when the health contract changes (ops / deploy verification). */
    healthSchemaVersion: number;
    ok: true;
    service: 'mint-engine';
    mode: string;
    executionEnabled: boolean;
    mainnetBroadcastEnabled: boolean;
    mainnetBeta: boolean;
    mainnetDryRun: boolean;
    /** Effective stop: env OR persisted runtime (when DB read succeeds). */
    emergencyStop: boolean;
    /** False when the runtime DB row could not be read; `emergencyStop` is then env-only (`MINT_EMERGENCY_STOP`). */
    runtimeEmergencyStopAvailable: boolean;
    testnetOnly: boolean;
    signerConfigured: boolean;
    signerMode: string;
    signerMainnetApproved: boolean;
    signerAddressMasked: string | null;
    /** Present when signer is not fully configured (e.g. missing env); `null` when ok. */
    signerBlockReason: string | null;
    defaultChainId: number;
    copyMintLiveEnabled: boolean;
    privateRelayEnabled: boolean;
    autoReplaceEnabled: boolean;
    manualConfirmationRequired: boolean;
    maxActiveJobs: number;
    maxQuantity: number;
};

export async function buildMintEngineHealthPayload(prisma: PrismaClient): Promise<MintEngineHealthPublicJson> {
    let emergencyStop: boolean;
    let runtimeEmergencyStopAvailable: boolean;
    if (mintEnv.MINT_EMERGENCY_STOP) {
        emergencyStop = true;
        runtimeEmergencyStopAvailable = true;
    } else {
        try {
            const row = await prisma.mintEngineRuntimeState.findUnique({ where: { id: 'default' } });
            emergencyStop = row?.emergencyStop === true;
            runtimeEmergencyStopAvailable = true;
        } catch {
            emergencyStop = mintEnv.MINT_EMERGENCY_STOP;
            runtimeEmergencyStopAvailable = false;
        }
    }

    const signer = new SignerAdapter();
    return {
        healthSchemaVersion: 3,
        ok: true,
        service: 'mint-engine',
        mode: mintEnv.MINT_ENGINE_MODE,
        executionEnabled: mintEnv.MINT_EXECUTION_ENABLED,
        mainnetBroadcastEnabled: mintEnv.MINT_MAINNET_BROADCAST_ENABLED,
        mainnetBeta: mintEnv.MINT_MAINNET_BETA,
        mainnetDryRun: mintEnv.MINT_MAINNET_DRY_RUN,
        emergencyStop,
        runtimeEmergencyStopAvailable,
        testnetOnly: mintEnv.MINT_TESTNET_ONLY,
        signerConfigured: signer.signerConfigured(),
        signerMode: signer.resolveMode(),
        signerMainnetApproved: signer.signerMainnetApproved(),
        signerAddressMasked: signer.signerAddressMasked(),
        signerBlockReason: signer.signerBlockReason(),
        defaultChainId: mintEnv.MINT_DEFAULT_CHAIN_ID,
        copyMintLiveEnabled: mintEnv.MINT_MAINNET_COPY_LIVE_ENABLED,
        privateRelayEnabled: mintEnv.MINT_MAINNET_PRIVATE_RELAY_ENABLED,
        autoReplaceEnabled: mintEnv.MINT_MAINNET_AUTO_REPLACE_ENABLED,
        manualConfirmationRequired: mintEnv.MINT_MAINNET_REQUIRE_MANUAL_CONFIRMATION,
        maxActiveJobs: mintEnv.MINT_MAINNET_MAX_ACTIVE_JOBS,
        maxQuantity: mintEnv.MINT_MAINNET_MAX_QUANTITY,
    };
}
