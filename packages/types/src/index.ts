export interface WalletProfile {
    address: string;
    winRate: number;
    totalFlips: number;
    realizedProfit: number;
    labels?: string[];
}

export type SignalGrade = 
    | 'Strong Bullish' 
    | 'Weak Bullish' 
    | 'Neutral' 
    | 'Weak Bearish' 
    | 'Strong Bearish' 
    | 'High Risk' 
    | 'Suspicious Activity';

/** Labels returned by deterministic contextual scoring (Discord-facing copy). */
export type ContextualSignalLabel =
    | 'Strong bullish signal'
    | 'Weak bullish signal'
    | 'Neutral activity'
    | 'Weak bearish signal'
    | 'Strong bearish signal'
    | 'Suspicious activity'
    | 'High-risk momentum'
    | 'Insufficient data'
    /** Collection Opportunity Monitor (informational; not trade advice). */
    | 'Strong momentum signal'
    | 'Developing opportunity signal'
    | 'Early watch signal'
    | 'Weak / unconfirmed'
    | 'Ignore'
    | 'Suspicious momentum'
    | 'High-risk momentum signal'
    | 'Insufficient verified data';

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'insufficient';

export interface ContextualExplanation {
    event: string;
    context: string;
    signal: ContextualSignalLabel;
    evidence: string[];
    risk: string;
    nextWatch: string;
    confidence: ConfidenceLevel;
    dataLimitations: string[];
}

export interface IntelligenceReport {
    grade: SignalGrade;
    context: string;
    risk: string | null;
    nextWatch: string;
    /** Rich structured explanations for Discord embeds (deterministic baseline). */
    contextual?: ContextualExplanation;
    /** Optional plain-language recap when AI layering is enabled; never adds metrics. */
    aiNarrative?: string | null;
}

export interface WhaleAlertData {
    alertType: 'WHALE_BUY';
    wallet: string;
    contract: string;
    collectionName: string;
    txHash: string;
    chain: string;
    channelId: string;
    report?: IntelligenceReport;
}
