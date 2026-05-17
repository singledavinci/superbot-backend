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
    opportunity: 0x6366f1,
    neutral: 0x64748b,
} as const satisfies Record<string, ColorResolvable>;

export const STANDARD_MARKET_DISCLAIMER =
    'Not financial advice. Signals are informational and may be incomplete or delayed.';

export function superbotFooter(productLine: string): string {
    return `SuperBot · ${productLine} · ${STANDARD_MARKET_DISCLAIMER}`;
}

export function alertCategoryLine(category: string, signal?: string): string {
    const sig = signal?.trim() ? ` · **${signal.trim()}**` : '';
    return `**${category}**${sig}`;
}