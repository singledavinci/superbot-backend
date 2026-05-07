import { WalletProfile, IntelligenceReport } from '@superbot/types';
export declare class ContextEngine {
    /**
     * Analyzes a whale buy event and generates contextual insights.
     */
    analyzeWhaleBuy(profile: WalletProfile, isFirstEntry: boolean, floorChange1h: number, listingChange1h: number, uniqueBuyers1h: number, isWashTrade?: boolean): IntelligenceReport;
    /**
     * Advanced heuristic for wash trading detection.
     */
    detectWashTrade(buyer: string, seller: string, sameFundingSource: boolean, walletAgeDays: number): boolean;
}
//# sourceMappingURL=index.d.ts.map