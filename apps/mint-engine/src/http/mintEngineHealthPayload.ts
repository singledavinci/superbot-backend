import type { PrismaClient } from '@superbot/database';
import { mintEnv } from '../config/mintEnv';
import { getEffectiveEmergencyStop } from '../engine/emergencyRuntime';
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
    emergencyStop: boolean;
    testnetOnly: boolean;
    signerConfigured: boolean;
    defaultChainId: number;
    copyMintLiveEnabled: boolean;
    privateRelayEnabled: boolean;
    autoReplaceEnabled: boolean;
    manualConfirmationRequired: boolean;
    maxActiveJobs: number;
    maxQuantity: number;
};

export async function buildMintEngineHealthPayload(prisma: PrismaClient): Promise<MintEngineHealthPublicJson> {
    const emergencyStop = await getEffectiveEmergencyStop(prisma);
    const signer = new SignerAdapter();
    return {
        healthSchemaVersion: 2,
        ok: true,
        service: 'mint-engine',
        mode: mintEnv.MINT_ENGINE_MODE,
        executionEnabled: mintEnv.MINT_EXECUTION_ENABLED,
        mainnetBroadcastEnabled: mintEnv.MINT_MAINNET_BROADCAST_ENABLED,
        mainnetBeta: mintEnv.MINT_MAINNET_BETA,
        mainnetDryRun: mintEnv.MINT_MAINNET_DRY_RUN,
        emergencyStop,
        testnetOnly: mintEnv.MINT_TESTNET_ONLY,
        signerConfigured: signer.signerConfigured(),
        defaultChainId: mintEnv.MINT_DEFAULT_CHAIN_ID,
        copyMintLiveEnabled: mintEnv.MINT_MAINNET_COPY_LIVE_ENABLED,
        privateRelayEnabled: mintEnv.MINT_MAINNET_PRIVATE_RELAY_ENABLED,
        autoReplaceEnabled: mintEnv.MINT_MAINNET_AUTO_REPLACE_ENABLED,
        manualConfirmationRequired: mintEnv.MINT_MAINNET_REQUIRE_MANUAL_CONFIRMATION,
        maxActiveJobs: mintEnv.MINT_MAINNET_MAX_ACTIVE_JOBS,
        maxQuantity: mintEnv.MINT_MAINNET_MAX_QUANTITY,
    };
}
