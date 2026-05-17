import type { ColorResolvable } from 'discord.js';

export const BRAND_ACCENT = 0x5865f2 as const;

export const EMBED_COLORS = {
    brand: BRAND_ACCENT,
    mint: 0xffb020,
    hotMint: 0xf97316,
    whaleBuy: 0x22c55e,
    whaleSale: 0xef4444,
    whaleMint: 0x06b6d4,
    sweep: 0xf97316,
    cluster: 0xeab308,
    listing: 0x38bdf8,
    delist: 0x34d399,
    floorDrop: 0xef4444,
    floorRise: 0x22c55e,
    batch: 0x6366f1,
    opportunity: 0x8b5cf6,
    neutral: 0x64748b,
} as const satisfies Record<string, ColorResolvable>;

export const STANDARD_MARKET_DISCLAIMER =
    'Not financial advice. Signals are informational and may be incomplete or delayed.';

export function superbotFooter(productLine: string): string {
    return `SuperBot | ${productLine} | ${STANDARD_MARKET_DISCLAIMER}`;
}

export function alertCategoryLine(category: string, signal?: string): string {
    const sig = signal?.trim() ? ` - **${signal.trim()}**` : '';
    return `**${category}**${sig}`;
}

const GRADE_ICONS: Record<string, string> = {
    'Strong Bullish': '\u{1F7E2}',
    'Weak Bullish': '\u{1F7E2}',
    Neutral: '\u26AA',
    'Weak Bearish': '\u{1F7E0}',
    'Strong Bearish': '\u{1F534}',
    'High Risk': '\u26A0\uFE0F',
    'Suspicious Activity': '\u{1F6A9}',
};

export function gradeBadge(grade?: string | null): string {
    const g = grade?.trim() || 'Neutral';
    const icon = GRADE_ICONS[g] ?? '\u26AA';
    return `${icon} \`${g}\``;
}

export function gradeAccentColor(grade?: string | null): ColorResolvable {
    switch (grade?.trim()) {
        case 'Strong Bullish':
        case 'Weak Bullish':
            return EMBED_COLORS.whaleBuy;
        case 'Weak Bearish':
        case 'Strong Bearish':
            return EMBED_COLORS.whaleSale;
        case 'High Risk':
        case 'Suspicious Activity':
            return EMBED_COLORS.hotMint;
        case 'Neutral':
            return EMBED_COLORS.neutral;
        default:
            return EMBED_COLORS.whaleBuy;
    }
}

export function whaleEmbedColor(alertType: string): ColorResolvable {
    if (alertType === 'WHALE_SALE') return EMBED_COLORS.whaleSale;
    if (alertType === 'WHALE_MINT') return EMBED_COLORS.whaleMint;
    return EMBED_COLORS.whaleBuy;
}

export function batchEmbedColor(behavior: 'buy' | 'sale' | 'mint'): ColorResolvable {
    if (behavior === 'sale') return EMBED_COLORS.whaleSale;
    if (behavior === 'mint') return EMBED_COLORS.whaleMint;
    return EMBED_COLORS.batch;
}

const BAR_FILL = '\u2588';
const BAR_EMPTY = '\u2591';

export function intensityBar(ratio: number, width = 10): string {
    const r = Math.min(1, Math.max(0, ratio));
    const filled = Math.round(r * width);
    return BAR_FILL.repeat(filled) + BAR_EMPTY.repeat(width - filled);
}

export function formatPctChange(pct: number | null | undefined): string {
    if (pct == null || Number.isNaN(pct)) return '-';
    const arrow = pct > 0.05 ? '\u{1F4C8}' : pct < -0.05 ? '\u{1F4C9}' : '\u2796';
    return `${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

export function scoreMeter(score: number, max = 100): string {
    const clamped = Math.min(max, Math.max(0, score));
    const bar = intensityBar(clamped / max, 12);
    return `${bar} **${clamped}** / ${max}`;
}