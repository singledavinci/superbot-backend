export interface OpportunityGuildSettingsParsed {
    enabled: boolean;
    channelDiscordId: string | null;
    scoreThreshold: number | null;
    cooldownMs: number | null;
    minUniqueBuyers: number | null;
    mentionRoleId: string | null;
}

export function parseOpportunityGuildSettings(settings: unknown): OpportunityGuildSettingsParsed {
    const base: OpportunityGuildSettingsParsed = {
        enabled: true,
        channelDiscordId: null,
        scoreThreshold: null,
        cooldownMs: null,
        minUniqueBuyers: null,
        mentionRoleId: null,
    };
    if (!settings || typeof settings !== 'object' || settings === null) return base;
    const o = settings as Record<string, unknown>;
    const op = o.opportunity;
    if (!op || typeof op !== 'object' || op === null) return base;
    const x = op as Record<string, unknown>;
    if (x.enabled === false) base.enabled = false;
    if (typeof x.channelDiscordId === 'string' && /^\d{17,22}$/.test(x.channelDiscordId.trim())) {
        base.channelDiscordId = x.channelDiscordId.trim();
    }
    if (typeof x.scoreThreshold === 'number' && x.scoreThreshold > 0 && x.scoreThreshold <= 100) {
        base.scoreThreshold = Math.floor(x.scoreThreshold);
    }
    if (typeof x.cooldownMs === 'number' && x.cooldownMs >= 60_000 && x.cooldownMs <= 24 * 60 * 60 * 1000) {
        base.cooldownMs = Math.floor(x.cooldownMs);
    }
    if (typeof x.minUniqueBuyers === 'number' && x.minUniqueBuyers >= 1 && x.minUniqueBuyers <= 50) {
        base.minUniqueBuyers = Math.floor(x.minUniqueBuyers);
    }
    if (typeof x.mentionRoleId === 'string' && /^\d{17,22}$/.test(x.mentionRoleId.trim())) {
        base.mentionRoleId = x.mentionRoleId.trim();
    }
    return base;
}
