/** Shared output guardrail for AI recaps — no Redis / networking. */

/** Hard safety: reject user-visible strings that imply financial advice or certainty. */
const FORBIDDEN_PHRASE_PATTERNS: RegExp[] = [
    /\bbuy\s+now\b/gi,
    /\bguaranteed\s+pump\b/gi,
    /\beasy\s+profit\b/gi,
    /\bsure\s+trade\b/gi,
    /\bape\s+in\b/gi,
    /\bmust\s+buy\b/gi,
    /\bbest\s+trade\b/gi,
    /\b100%\s*bullish\b/gi,
    /\bprofit\s+opportunity\b/gi,
    /\byou\s+should\s+enter\b/gi,
    /\bsafe\b/gi,
    /\bguaranteed\b/gi,
    /\brisk-?free\b/gi,
];

export function containsForbiddenTradingPhrases(text: string): boolean {
    if (!text) return false;
    return FORBIDDEN_PHRASE_PATTERNS.some(re => {
        re.lastIndex = 0;
        return re.test(text);
    });
}

/** Returns null if copy is unsafe; otherwise trimmed bounded text. */
export function sanitizeUserVisibleOpportunityText(text: string): string | null {
    if (!text) return null;
    if (containsForbiddenTradingPhrases(text)) return null;
    return text.slice(0, 1800);
}

export function sanitizeAiOutput(text: string): string | null {
    if (!text) return null;
    if (containsForbiddenTradingPhrases(text)) return null;
    const banned =
        /\b(?:buy|sell)\b|\bmint\s+now\b|\bguaranteed\b|\bhodl\b|\bape\b/gi.test(
            text,
        );
    if (banned) return null;
    return text.slice(0, 900);
}
