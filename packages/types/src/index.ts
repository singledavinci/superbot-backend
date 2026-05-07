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

export interface IntelligenceReport {
    grade: SignalGrade;
    context: string;
    risk: string | null;
    nextWatch: string;
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
