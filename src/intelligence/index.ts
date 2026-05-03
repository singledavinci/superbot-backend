import { WalletProfile } from '../analytics/profiler';

export type SignalGrade = 
    | 'Strong Bullish' 
    | 'Weak Bullish' 
    | 'Neutral' 
    | 'Weak Bearish' 
    | 'Strong Bearish' 
    | 'High Risk' 
    | 'Suspicious Activity';

export interface IntelligenceReport {
    grade: SignalGrade;
    context: string;
    risk: string | null;
    nextWatch: string;
}

export class ContextEngine {
    /**
     * Analyzes a whale buy event and generates contextual insights.
     */
    public analyzeWhaleBuy(
        profile: WalletProfile, 
        isFirstEntry: boolean, 
        floorChange1h: number, 
        listingChange1h: number,
        uniqueBuyers1h: number
    ): IntelligenceReport {
        let grade: SignalGrade = 'Neutral';
        let context = '';
        let risk: string | null = null;
        let nextWatch = '';

        if (profile.winRate > 0.6) {
            context += `This wallet has a ${(profile.winRate * 100).toFixed(0)}% profitable flip rate across ${profile.totalFlips} trades. `;
            if (isFirstEntry) context += `This is the wallet's first entry into the collection. `;
            
            if (floorChange1h > 0.05 && listingChange1h < 0) {
                grade = 'Strong Bullish';
                context += `Floor price is up ${(floorChange1h * 100).toFixed(1)}% in 1 hour, and listings are dropping, indicating organic momentum. `;
            } else if (floorChange1h > 0) {
                grade = 'Weak Bullish';
                context += `Floor price is up ${(floorChange1h * 100).toFixed(1)}% in 1 hour, but listings are also rising. Momentum is present but not clean. `;
            } else {
                grade = 'Neutral';
                context += `Floor price is currently flat or down. `;
            }
        } else {
            context += `This wallet has a moderate/low profit history. `;
        }

        if (uniqueBuyers1h < 15) {
            if (grade === 'Strong Bullish') grade = 'High Risk';
            risk = `Only ${uniqueBuyers1h} unique buyers in the last hour; demand may not be broad enough yet.`;
            nextWatch = `Monitor whether unique buyers increase and listings continue to fall.`;
        } else {
            nextWatch = `Watch for further smart money accumulation or resistance at the next psychological floor.`;
        }

        return { grade, context, risk, nextWatch };
    }

    /**
     * Basic heuristic for wash trading detection.
     */
    public detectWashTrade(buyer: string, seller: string, sameFundingSource: boolean): boolean {
        if (buyer.toLowerCase() === seller.toLowerCase()) return true;
        if (sameFundingSource) return true;
        return false;
    }
}
