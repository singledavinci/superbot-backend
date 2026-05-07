import { JsonRpcProvider } from 'ethers';
export interface SniperOptions {
    maxMintLimit?: number;
    gasBribeGwei?: number;
    mevProtection?: boolean;
    skipSimulation?: boolean;
    overdrive?: boolean;
    nonce?: number;
    balance?: bigint;
}
/**
 * High-performance NFT Sniper Engine
 * Ported from the SuperBot Sniper Core for ultra-fast execution.
 */
export declare class SniperEngine {
    private provider;
    constructor(provider: JsonRpcProvider);
    executeCopyTrade(privateKey: string, to: string, data: string, value: string, options?: SniperOptions): Promise<import("ethers").TransactionResponse>;
    /**
     * Attempts to 'Hijack' the payload if it's a known router or contains the whale address.
     */
    preparePayload(data: string, whaleAddress: string, myAddress: string): Promise<string>;
}
//# sourceMappingURL=sniper.d.ts.map