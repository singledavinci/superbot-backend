import { mintEnv } from '../config/mintEnv';

/**
 * Hard guard: never broadcast to mainnet unless explicitly enabled.
 * Throw so callers cannot accidentally skip checks.
 */
export function assertMainnetBroadcastAllowed(chainId: number): void {
    if (chainId !== 1) return;
    if (!mintEnv.MINT_MAINNET_BROADCAST_ENABLED) {
        const err = new Error('MAINNET_DISABLED');
        (err as Error & { code?: string }).code = 'MAINNET_DISABLED';
        throw err;
    }
    if (mintEnv.MINT_TESTNET_ONLY) {
        const err = new Error('MAINNET_DISABLED');
        (err as Error & { code?: string }).code = 'MAINNET_DISABLED';
        throw err;
    }
}

export function isMainnetChain(chainId: number): boolean {
    return chainId === 1;
}
