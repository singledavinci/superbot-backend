/** Guild-level AlertChannel row (Discord snowflakes as strings). */
export type AlertChannelRow = {
    alertType: string;
    discordChannelId: string;
    mentionRoleId?: string | null;
};

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

function debugRouteLog(payload: {
    hypothesisId: string;
    alertType: string;
    channelId: string | null;
    mentionRoleId: string | null;
    source: string;
}) {
    fetch('http://127.0.0.1:7317/ingest/2a91f8bc-a1ce-4ea6-8234-d779e4605c12', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '482b27' },
        body: JSON.stringify({
            sessionId: '482b27',
            location: 'alertRouting.ts:resolveAlertRoute',
            message: 'alert route resolved',
            hypothesisId: payload.hypothesisId,
            data: payload,
            timestamp: Date.now(),
            runId: 'pre-fix',
        }),
    }).catch(() => {});
}

export function resolveAlertRoute(
    channels: AlertChannelRow[],
    alertType: string,
    opts?: {
        channelOverride?: string | null;
        mentionRoleOverride?: string | null;
        debug?: boolean;
        hypothesisId?: string;
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

    if (opts?.debug) {
        debugRouteLog({
            hypothesisId: opts.hypothesisId ?? 'route',
            alertType,
            channelId,
            mentionRoleId,
            source: channelSource,
        });
    }

    return { alertType, channelId, mentionRoleId, source: channelSource };
}

export function resolveDiscordChannel(
    channels: AlertChannelRow[],
    alertType: string,
    channelOverride?: string | null,
): string | null {
    return resolveAlertRoute(channels, alertType, { channelOverride }).channelId;
}

export function resolveMentionRole(
    channels: AlertChannelRow[],
    alertType: string,
    mentionRoleOverride?: string | null,
): string | null {
    return resolveAlertRoute(channels, alertType, { mentionRoleOverride }).mentionRoleId;
}