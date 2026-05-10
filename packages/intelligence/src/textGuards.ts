/** Shared output guardrail for AI recaps — no Redis / networking. */

export function sanitizeAiOutput(text: string): string | null {
    if (!text) return null;
    const banned =
        /\b(?:buy|sell)\b|\bmint\s+now\b|\bguaranteed\b|\bhodl\b|\bape\b/gi.test(
            text,
        );
    if (banned) return null;
    return text.slice(0, 900);
}
