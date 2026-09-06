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
    // MintDash radar cards — never fall back into tracked mint radar.
    NEW_COLLECTION: ['NEW_COLLECTION'],
    RADAR_DEBUG: ['RADAR_DEBUG'],
    MINTABLE_NOW: ['MINTABLE_NOW'],
    WHITELIST_ONLY: ['WHITELIST_ONLY'],
};
