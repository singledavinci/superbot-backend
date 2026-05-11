import { mintEnv, isLiveEngineMode, isPrepareEngineMode } from '../config/mintEnv';

export type PolicyDecision =
    | 'ALLOW_SIMULATION'
    | 'ALLOW_PREPARE'
    | 'ALLOW_LIVE_EXECUTION'
    | 'BLOCK_EXECUTION_DISABLED'
    | 'BLOCK_MAINNET_DISABLED'
    | 'BLOCK_EMERGENCY_STOP'
    | 'BLOCK_SIGNER_MISSING'
    | 'BLOCK_NOT_ELIGIBLE'
    | 'BLOCK_GAS_CAP'
    | 'BLOCK_PRICE_UNKNOWN'
    | 'BLOCK_FUNCTION_UNKNOWN'
    | 'BLOCK_NONCE_CONFLICT'
    | 'BLOCK_PROVIDER_UNHEALTHY'
    | 'BLOCK_STAGE_UNVERIFIED'
    | 'BLOCK_CLOCK_DRIFT'
    | 'BLOCK_RISK_TOO_HIGH'
    | 'BLOCK_SIMULATION'
    | 'BLOCK_WALLET_NOT_AUTHORIZED'
    | 'BLOCK_MAINNET_READINESS';

export interface PolicyInput {
    walletAuthorized: boolean;
    simulationOk: boolean;
    simulationStatus?: string;
    signerConfigured: boolean;
    nonceOk: boolean;
    clockDriftOk: boolean;
    chainId: number;
    /** When true, Postgres vs Redis nonce mirror disagreed — block live. */
    nonceStateUncertain?: boolean;
    /** MainnetReadinessGate allows mainnet broadcast */
    mainnetReadinessOk?: boolean;
}

export class ExecutionPolicyEngine {
    decideLive(input: PolicyInput): PolicyDecision {
        if (mintEnv.MINT_EMERGENCY_STOP) return 'BLOCK_EMERGENCY_STOP';
        if (!mintEnv.MINT_EXECUTION_ENABLED) return 'BLOCK_EXECUTION_DISABLED';
        if (!input.walletAuthorized) return 'BLOCK_WALLET_NOT_AUTHORIZED';
        if (input.nonceStateUncertain) return 'BLOCK_NONCE_CONFLICT';
        if (!input.nonceOk) return 'BLOCK_NONCE_CONFLICT';
        if (!input.clockDriftOk && mintEnv.MINT_CLOCK_DRIFT_CHECK_ENABLED) return 'BLOCK_CLOCK_DRIFT';
        if (!input.signerConfigured && mintEnv.MINT_REQUIRE_SECURE_SIGNER) return 'BLOCK_SIGNER_MISSING';
        if (!input.simulationOk) return 'BLOCK_SIMULATION';

        const mainnet = mintEnv.MINT_DEFAULT_CHAIN_ID === 1 || input.chainId === 1;
        if (mainnet && mintEnv.MINT_TESTNET_ONLY) return 'BLOCK_MAINNET_DISABLED';
        if (mainnet && !mintEnv.MINT_MAINNET_BROADCAST_ENABLED) return 'BLOCK_MAINNET_DISABLED';
        if (mainnet && input.mainnetReadinessOk === false) return 'BLOCK_MAINNET_READINESS';

        if (!isLiveEngineMode()) return 'BLOCK_EXECUTION_DISABLED';

        return 'ALLOW_LIVE_EXECUTION';
    }

    decidePrepare(input: Pick<PolicyInput, 'walletAuthorized' | 'simulationOk' | 'nonceStateUncertain'>): PolicyDecision {
        if (mintEnv.MINT_EMERGENCY_STOP) {
            // prepare/simulation still allowed for visibility
        }
        if (!mintEnv.MINT_EXECUTION_ENABLED && !isPrepareEngineMode() && !isLiveEngineMode()) {
            return 'BLOCK_EXECUTION_DISABLED';
        }
        if (!input.walletAuthorized) return 'BLOCK_WALLET_NOT_AUTHORIZED';
        if (input.nonceStateUncertain) return 'BLOCK_NONCE_CONFLICT';
        if (!input.simulationOk) return 'BLOCK_SIMULATION';
        if (!isPrepareEngineMode() && !isLiveEngineMode() && mintEnv.MINT_ENGINE_MODE !== 'simulation') {
            return 'BLOCK_EXECUTION_DISABLED';
        }
        return 'ALLOW_PREPARE';
    }

    decideSimulation(input: Pick<PolicyInput, 'walletAuthorized'>): PolicyDecision {
        if (!input.walletAuthorized) return 'BLOCK_WALLET_NOT_AUTHORIZED';
        return 'ALLOW_SIMULATION';
    }
}
