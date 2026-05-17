/** Guild-level AlertChannel row (Discord snowflakes as strings). */
export type AlertChannelRow = {
    alertType: string;
    discordChannelId: string;
    mentionRoleId?: string | null;
};

/** Preference order when resolving channel + ping role for each alert type. */
export const ALERT_ROUTE_PREFERENCE: Record<string, readonly string[]> = {
    WHALE_BUY: ['WHALE_BUY', 'WHALE_SALE'],
    WHALE_SALE: ['WHALE_SALE', 'WHALE_BUY'],
    WHALE_MINT: ['WHALE_MINT', 'MINT_RADAR', 'WHALE_BUY'],
    CLUSTER_BUY: ['CLUSTER_BUY', 'WHALE_BUY'],
    SWEEP: ['SWEEP', 'WHALE_BUY'],
    HOT_MINT: ['HOT_MINT', 'MINT_RADAR'],
    MINT_RADAR: ['MINT_RADAR'],
    WALLET_ACTION_BATCH: ['WALLET_ACTION_BATCH', 'WHALE_BUY'],
    MASS_LISTING: ['MASS_LISTING'],
    MASS_DELIST: ['MASS_DELIST'],
    FLOOR_IMPACT_FOLLOWUP: ['FLOOR_IMPACT_FOLLOWUP', 'MASS_LISTING', 'MASS_DELIST'],
    FLOOR_DROP: ['FLOOR_DROP', 'FLOOR_RISE'],
    FLOOR_RISE: ['FLOOR_RISE', 'FLOOR_DROP'],
    OPPORTUNITY_SPIKE: ['OPPORTUNITY_SPIKE'],
};

export type AlertRouteResolution = {
    alertType: string;
    channelId: string | null;
    mentionRoleId: string | null;
    source: 'override' | 'guild_route' | 'missing';
};

function preferenceFor(alertType: string): readonly string[] {
    return ALERT_ROUTE_PREFERENCE[alertType] ?? [alertType];
}

/**
 * Resolve Discord channel + ping role for an alert.
 * Per-collection alertChannelId must NOT be used for specialized alerts — only explicit
 * overrides (e.g. hotMintChannelId, delistChannelId, wallet.alertChannelId) or guild routes.
 */
export function resolveAlertRoute(
    channels: AlertChannelRow[],
    alertType: string,
    opts?: {
        channelOverride?: string | null;
        mentionRoleOverride?: string | null;
    },
): AlertRouteResolution {
    const prefs = preferenceFor(alertType);

    let channelId: string | null = null;
    let channelSource: AlertRouteResolution['source'] = 'missing';
    const chOverride =
        typeof opts?.channelOverride === 'string' ? opts.channelOverride.trim() : '';
    if (chOverride) {
        channelId = chOverride;
        channelSource = 'override';
    } else {
        for (const t of prefs) {
            const row = channels.find(c => c.alertType === t);
            if (row?.discordChannelId) {
                channelId = row.discordChannelId;
                channelSource = 'guild_route';
                break;
            }
        }
    }

    let mentionRoleId: string | null = null;
    const roleOverride =
        typeof opts?.mentionRoleOverride === 'string' ? opts.mentionRoleOverride.trim() : '';
    if (roleOverride) {
        mentionRoleId = roleOverride;
    } else {
        for (const t of prefs) {
            const row = channels.find(c => c.alertType === t);
            const id = row?.mentionRoleId;
            if (typeof id === 'string' && id.trim()) {
                mentionRoleId = id.trim();
                break;
            }
        }
    }

    return { alertType, channelId, mentionRoleId, source: channelSource };
}

/** @deprecated Use resolveAlertRoute */
export function resolveDiscordChannel(
    channels: AlertChannelRow[],
    alertType: string,
    channelOverride?: string | null,
): string | null {
    return resolveAlertRoute(channels, alertType, { channelOverride }).channelId;
}

/** @deprecated Use resolveAlertRoute */
export function resolveMentionRole(
    channels: AlertChannelRow[],
    alertType: string,
    mentionRoleOverride?: string | null,
): string | null {
    return resolveAlertRoute(channels, alertType, { mentionRoleOverride }).mentionRoleId;
}