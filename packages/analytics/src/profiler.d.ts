import { WalletProfile } from '@superbot/types';
export declare class SmartMoneyProfiler {
    private apiKey;
    private baseUrl;
    constructor();
    /**
     * Fetches historical performance data for an EVM wallet.
     * Integrates with a 3rd party API to calculate win rates.
     */
    getWalletProfile(address: string): Promise<WalletProfile>;
    /**
     * Fallback mock data generator based on address hash.
     */
    private simulateProfile;
}
//# sourceMappingURL=profiler.d.ts.map