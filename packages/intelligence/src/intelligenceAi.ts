import { redisConnection } from '@superbot/queue';
import type { ContextualExplanation } from '@superbot/types';
import { sanitizeAiOutput } from './textGuards';

/**
 * AI is strictly optional prose on top of structured facts. Facts must be deterministic.
 * Disabled unless INTELLIGENCE_AI_ENABLED=true plus OPENAI_API_KEY.
 */
export async function summarizeFactsWithOptionalAi(opts: {
    explanation: ContextualExplanation;
    jobCacheKey: string;
}): Promise<string | null> {
    if (process.env.INTELLIGENCE_AI_ENABLED !== 'true') return null;
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.INTELLIGENCE_AI_MODEL || 'gpt-4o-mini';
    if (!apiKey?.trim()) return null;

    const cacheKey = `intel:ai:ctx:${opts.jobCacheKey}`;
    try {
        const cached = await redisConnection.get(cacheKey);
        if (cached) return cached;
    } catch {
        /* cache miss semantics */
    }

    const rpm = Number(process.env.INTELLIGENCE_AI_MAX_PER_MINUTE) || 60;
    const bucket = Math.floor(Date.now() / 60_000);
    const rlKey = `intel:ai:rpm:${bucket}`;
    try {
        const n = await redisConnection.incr(rlKey);
        if (n === 1) await redisConnection.expire(rlKey, 120);
        if (n > rpm) return null;
    } catch {
        /* best-effort */
    }

    const factual = structuredFacts(opts.explanation);

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: 'system',
                        content: [
                            'You paraphrase pre-computed NFT market surveillance notes.',
                            'Do NOT give financial advice.',
                            'Do NOT recommend buying, selling, minting, or holding assets.',
                            'Use ONLY the structured facts supplied. Never invent quantities, percentages, wallets, volumes, profitability, rarity, liquidity, holders, floors, timestamps, venues, chains, wallets, hashes, thresholds, totals, velocities, correlations, rankings, probabilities, forecasts, certainty, urgency, hype, slang, meme trading language, emoji, hashtags, sarcasm.',
                            'Say "Insufficient verified data." when facts mark missing verified data portions.',
                            'Return at most four short sentences, plain ASCII, informational tone.',
                        ].join(' '),
                    },
                    {
                        role: 'user',
                        content: JSON.stringify({ facts: factual }),
                    },
                ],
                temperature: 0,
                max_tokens: 320,
            }),
        });

        if (!res.ok) return null;
        const payload = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const text =
            typeof payload?.choices?.[0]?.message?.content === 'string'
                ? payload!.choices![0]!.message!.content!.trim()
                : '';

        const safe = sanitizeAiOutput(text);
        if (!safe) return null;

        const ttl =
            Number(process.env.INTELLIGENCE_AI_CACHE_SECONDS) > 0
                ? Number(process.env.INTELLIGENCE_AI_CACHE_SECONDS)
                : 86400;

        await redisConnection.setex(cacheKey, ttl, safe);
        return safe;
    } catch {
        return null;
    }
}

function structuredFacts(cx: ContextualExplanation) {
    return {
        event: cx.event,
        context: cx.context,
        signal: cx.signal,
        evidence: cx.evidence,
        risk: cx.risk,
        nextWatch: cx.nextWatch,
        confidence: cx.confidence,
        dataLimitations: cx.dataLimitations,
    };
}

export { sanitizeAiOutput } from './textGuards';
