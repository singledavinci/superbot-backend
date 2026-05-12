import { mintEnv, isLiveEngineMode } from '../config/mintEnv';

/**
 * Env-level guard: never broadcast to mainnet unless explicit controlled-beta flags pass.
 * Job-level approval, simulation, nonce lock, and caps are enforced in MintExecutionEngine.
 */
export function assertMainnetBroadcastAllowed(chainId: number): void {
    if (chainId !== 1) return;
    const fail = (code: string) => {
        const err = new Error(code);
        (err as Error & { code?: string }).code = code;
        throw err;
    };
    if (!mintEnv.MINT_MAINNET_BROADCAST_ENABLED) fail('MAINNET_DISABLED');
    if (mintEnv.MINT_TESTNET_ONLY) fail('MAINNET_DISABLED');
    if (!mintEnv.MINT_EXECUTION_ENABLED) fail('MAINNET_DISABLED');
    if (!isLiveEngineMode()) fail('MAINNET_DRY_RUN_ONLY');
    if (!mintEnv.MINT_MAINNET_BETA) fail('MAINNET_BETA_DISABLED');
}

export function isMainnetChain(chainId: number): boolean {
    return chainId === 1;
}
