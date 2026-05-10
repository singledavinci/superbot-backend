/**
 * Shared types for normalized NFT sales sources (Alchemy, Reservoir, …).
 *
 * Each provider hands back the same `NormalizedSale` shape and an opaque
 * `cursor` that the caller persists per (chain, contract). The cursor format
 * is provider-defined (e.g. last block number for Alchemy, last timestamp for
 * Reservoir) so SalesIndexer never has to interpret it.
 */
export interface NormalizedSale {
    eventId: string;        // Stable idempotency key, must round-trip per provider
    chain: string;
    contract: string;
    tokenId?: string;
    txHash: string;
    blockNumber?: number;
    timestamp: number;      // Unix seconds; 0 if provider does not expose one
    buyer: string;
    seller: string;
    priceNative: number;
    priceUsd?: number;
    currency: string;
    marketplace: string;
    raw: unknown;
}

export interface FetchSalesArgs {
    contract: string;
    chain?: string;
    cursor?: string;
    limit?: number;
}

export interface FetchSalesResult {
    sales: NormalizedSale[];
    nextCursor?: string;
}

/** Normalized marketplace listing / order-placed event (OpenSea v2, etc.). */
export interface NormalizedListing {
    eventId: string;
    chain: string;
    contract: string;
    tokenId?: string;
    timestamp: number;
    /** Listing side (seller / maker). */
    maker?: string;
    priceNative: number;
    currency: string;
    marketplace?: string;
    raw: unknown;
}

export interface FetchListingsArgs {
    contract: string;
    chain?: string;
    cursor?: string;
    limit?: number;
}

export interface FetchListingsResult {
    listings: NormalizedListing[];
    nextCursor?: string;
}

export interface FetchFloorArgs {
    contract: string;
    chain?: string;
}

export interface FetchFloorResult {
    priceNative: number;
    currency: string;
    source: string;
}

export interface SalesProvider {
    /** Short human label, used in logs and the `/status` command. */
    readonly name: string;
    isConfigured(): boolean;
    fetchSales(args: FetchSalesArgs): Promise<FetchSalesResult>;
    /** OpenSea-backed deployments populate this; others return an empty page. */
    fetchListings(args: FetchListingsArgs): Promise<FetchListingsResult>;
    /** Best effort floor for the contract; returns null when unavailable. */
    fetchFloor(args: FetchFloorArgs): Promise<FetchFloorResult | null>;
}
