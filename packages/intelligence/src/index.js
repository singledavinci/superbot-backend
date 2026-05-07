"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextEngine = void 0;
class ContextEngine {
    /**
     * Analyzes a whale buy event and generates contextual insights.
     */
    analyzeWhaleBuy(profile, isFirstEntry, floorChange1h, listingChange1h, uniqueBuyers1h, isWashTrade = false) {
        let grade = 'Neutral';
        let context = '';
        let risk = null;
        let nextWatch = '';
        if (isWashTrade) {
            return {
                grade: 'Suspicious Activity',
                context: 'Detected circular trading or common funding source between buyer and seller.',
                risk: 'High risk of artificial volume. Do not enter.',
                nextWatch: 'Verify the contract owner and creator wallets for similar patterns.'
            };
        }
        const isEliteWhale = profile.winRate > 0.7 && profile.totalFlips > 20;
        if (profile.winRate > 0.6) {
            context += `This ${isEliteWhale ? 'Elite ' : ''}wallet has a ${(profile.winRate * 100).toFixed(0)}% profitable flip rate across ${profile.totalFlips} trades. `;
            if (isFirstEntry)
                context += `This is the wallet's first entry into the collection. `;
            if (floorChange1h > 0.08 && listingChange1h < -0.05) {
                grade = 'Strong Bullish';
                context += `Exceptional momentum: Floor +${(floorChange1h * 100).toFixed(1)}% and listings -${(Math.abs(listingChange1h) * 100).toFixed(1)}% in 1h. `;
            }
            else if (floorChange1h > 0.02) {
                grade = 'Weak Bullish';
                context += `Moderate momentum: Floor +${(floorChange1h * 100).toFixed(1)}% in 1h. `;
            }
            else {
                grade = 'Neutral';
                context += `Floor price is currently stable. `;
            }
        }
        else {
            context += `This wallet has a moderate/low profit history. Accumulation here is less predictive. `;
        }
        // Risk Overlays
        if (uniqueBuyers1h < 10) {
            grade = 'High Risk';
            risk = `EXTREME RISK: Only ${uniqueBuyers1h} unique buyers in 1h. Very low liquidity.`;
            nextWatch = `Wait for unique buyers to cross 30 before considering an entry.`;
        }
        else if (uniqueBuyers1h < 25) {
            if (grade === 'Strong Bullish')
                grade = 'Weak Bullish'; // Downgrade due to concentration
            risk = `Low buyer diversity (${uniqueBuyers1h} unique). Price may be volatile.`;
            nextWatch = `Watch for more distributed accumulation across different wallet tiers.`;
        }
        else {
            nextWatch = `Watch for a potential breakout if floor volume sustains.`;
        }
        return { grade, context, risk, nextWatch };
    }
    /**
     * Advanced heuristic for wash trading detection.
     */
    detectWashTrade(buyer, seller, sameFundingSource, walletAgeDays) {
        // 1. Literal same address
        if (buyer.toLowerCase() === seller.toLowerCase())
            return true;
        // 2. Common funding (most reliable signal)
        if (sameFundingSource)
            return true;
        // 3. New wallet behavior (Fresh wallet + High value trade)
        if (walletAgeDays < 1) {
            // High risk of being a temporary wash wallet
            return true;
        }
        return false;
    }
}
exports.ContextEngine = ContextEngine;
//# sourceMappingURL=index.js.map