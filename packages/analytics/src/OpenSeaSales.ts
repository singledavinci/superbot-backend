import axios from 'axios';
import {
    FetchFloorArgs,
    FetchFloorResult,
    FetchListingsArgs,
    FetchListingsResult,
    FetchSalesArgs,
    FetchSalesResult,
    NormalizedListing,
    NormalizedSale,
    SalesProvider,
} from './SalesProvider';

interface OpenSeaPayment {
    quantity?: string;     // raw integer string in token's smallest unit
    token_address?: string;
    decimals?: number;
    symbol?: string;
}

interface OpenSeaNftRef {
    contract?: string;
    identifier?: string;
    chain?: string;
}

interface OpenSeaEvent {
    event_type?: string;
    chain?: string;
    transaction?: string;
    event_timestamp?: number;
    closing_date?: number;
    seller?: string;
    buyer?: string;
    nft?: OpenSeaNftRef;
    asset?: OpenSeaNftRef; // older shape
    order_hash?: string;
    payment?: OpenSeaPayment;
    quantity?: number;
}

interface OpenSeaEventsResponse {
    asset_events?: OpenSeaEvent[];
    next?: string | null;
}

interface OpenSeaContractResponse {
    collection?: string | { slug?: string };
}

interface OpenSeaCollectionStatsResponse {
    stats?: {
        floor_price?: number;
        total?: { floor_price?: number };
    };
    total?: { floor_price?: number };
    floor_price?: number;
}

interface OpenSeaListingLikeEvent extends OpenSeaEvent {
    order_hash?: string;
}

const OPENSEA_CHAIN_NAMES: Record<string, string> = {
    ethereum: 'ethereum',
};

/**
 * OpenSea API v2 sales source.
 *
 * Endpoint: GET /api/v2/events/chain/{chain}/contract/{contract}?event_type=sale
 * Docs:    https://docs.opensea.io/reference/list_events_by_nft_contract
 *
 * Cursor format: unix-seconds string (last `event_timestamp` we ingested).
 * On the next poll we set `after = cursor` so OpenSea only returns events
 * strictly newer than what we already saw.
 *
 * Free tier: requires an `X-API-KEY` header (request one at
 * https://docs.opensea.io/reference/api-keys). The provider reports
 * `isConfigured=false` until the key is set, so the SalesIndexer falls
 * through to the next provider.
 */
export class OpenSeaSalesClient implements SalesProvider {
    public readonly name = 'opensea';
    private apiKey: string;
    /** Avoid hammering OpenSea when resolving slug → stats for floor reads. */
    private slugByContract = new Map<string, string>();

    constructor(apiKey?: string) {
        this.apiKey = apiKey || process.env.OPENSEA_API_KEY || '';
    }

    public isConfigured(): boolean {
        if (!this.apiKey) return false;
        const v = this.apiKey.trim().toLowerCase();
        if (!v) return false;
        if (v.startsWith('placeholder')) return false;
        if (v === 'changeme' || v === 'todo' || v === 'tbd' || v === 'your_api_key') return false;
        return true;
    }

    public async fetchSales(args: FetchSalesArgs): Promise<FetchSalesResult> {
        if (!this.isConfigured()) return { sales: [] };

        const requestedChain = (args.chain || 'ethereum').toLowerCase();
        const chain = OPENSEA_CHAIN_NAMES[requestedChain];
        if (!chain) return { sales: [] };

        const limit = Math.min(args.limit ?? 50, 50); // OpenSea v2 caps at 50
        const after = args.cursor ? Number(args.cursor) : undefined;

        try {
            const response = await axios.get<OpenSeaEventsResponse>(
                `https://api.opensea.io/api/v2/events/chain/${chain}/contract/${args.contract}`,
                {
                    params: {
                        event_type: 'sale',
                        after,
                        limit,
                    },
                    headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' },
                    timeout: 15_000,
                },
            );

            const events = response.data?.asset_events ?? [];
            const sales = events
                .filter(e => (e.event_type ?? '').toLowerCase() === 'sale')
                .map(e => this.normalize(e, chain))
                .filter((s): s is NormalizedSale => s !== null);

            const maxTs = sales.reduce(
                (acc, s) => (s.timestamp > acc ? s.timestamp : acc),
                after ?? 0,
            );

            return {
                sales,
                nextCursor: maxTs ? String(maxTs + 1) : args.cursor,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(
                `[OpenSeaSalesClient] /events/chain/${chain}/contract/${args.contract} failed: ${message}`,
            );
            return { sales: [], nextCursor: args.cursor };
        }
    }

    public async fetchListings(args: FetchListingsArgs): Promise<FetchListingsResult> {
        if (!this.isConfigured()) return { listings: [] };

        const requestedChain = (args.chain || 'ethereum').toLowerCase();
        const chain = OPENSEA_CHAIN_NAMES[requestedChain];
        if (!chain) return { listings: [] };

        const limit = Math.min(args.limit ?? 50, 50);
        const after = args.cursor ? Number(args.cursor) : undefined;

        try {
            const response = await axios.get<OpenSeaEventsResponse>(
                `https://api.opensea.io/api/v2/events/chain/${chain}/contract/${args.contract}`,
                {
                    params: {
                        event_type: 'listing',
                        after,
                        limit,
                    },
                    headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' },
                    timeout: 15_000,
                },
            );

            const events = response.data?.asset_events ?? [];
            const listings = events
                .filter(e => {
                    const t = (e.event_type ?? '').toLowerCase();
                    return t === 'listing' || t === 'order';
                })
                .map(e => this.normalizeListing(e as OpenSeaListingLikeEvent, chain))
                .filter((l): l is NormalizedListing => l !== null);

            const maxTs = listings.reduce(
                (acc, l) => (l.timestamp > acc ? l.timestamp : acc),
                after ?? 0,
            );

            return {
                listings,
                nextCursor: maxTs ? String(maxTs + 1) : args.cursor,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(
                `[OpenSeaSalesClient] listings events chain/${chain}/contract/${args.contract} failed: ${message}`,
            );
            return { listings: [], nextCursor: args.cursor };
        }
    }

    public async fetchFloor(args: FetchFloorArgs): Promise<FetchFloorResult | null> {
        if (!this.isConfigured()) return null;

        const requestedChain = (args.chain || 'ethereum').toLowerCase();
        const chain = OPENSEA_CHAIN_NAMES[requestedChain];
        if (!chain) return null;

        const contract = args.contract.toLowerCase();

        try {
            const slug =
                this.slugByContract.get(`${chain}:${contract}`) ??
                (await this.resolveCollectionSlug(chain, contract));

            if (!slug) return null;

            const stats = await axios.get<OpenSeaCollectionStatsResponse>(
                `https://api.opensea.io/api/v2/collections/${slug}/stats`,
                {
                    headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' },
                    timeout: 15_000,
                },
            );

            const floor = extractFloorFromStats(stats.data);

            if (floor === null || floor === undefined || Number.isNaN(Number(floor))) {
                const best = await axios.get<{ listings?: Array<{ price?: { current?: { value?: string }; value?: number } }> }>(
                    `https://api.opensea.io/api/v2/listings/collection/${slug}/best`,
                    {
                        params: { limit: 1 },
                        headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' },
                        timeout: 15_000,
                    },
                );
                const first = best.data?.listings?.[0];
                const native =
                    first?.price?.current?.value !== undefined
                        ? Number(first.price.current.value)
                        : first?.price?.value !== undefined
                          ? Number((first.price as { value?: number }).value)
                          : null;
                if (native === null || Number.isNaN(native)) return null;
                return {
                    priceNative: native,
                    currency: 'ETH',
                    source: 'opensea_listings_best',
                };
            }

            return {
                priceNative: Number(floor),
                currency: 'ETH',
                source: 'opensea_collection_stats',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[OpenSeaSalesClient] fetchFloor failed for ${contract}: ${message}`);
            return null;
        }
    }

    private async resolveCollectionSlug(chain: string, contractLower: string): Promise<string | null> {
        const cacheKey = `${chain}:${contractLower}`;
        try {
            const response = await axios.get<OpenSeaContractResponse>(
                `https://api.opensea.io/api/v2/chain/${chain}/contract/${contractLower}`,
                {
                    headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' },
                    timeout: 15_000,
                },
            );
            const slug = extractCollectionSlug(response.data?.collection);
            if (slug) {
                this.slugByContract.set(cacheKey, slug);
                return slug;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[OpenSeaSalesClient] resolveCollectionSlug failed: ${message}`);
        }
        return null;
    }

    private normalizeListing(event: OpenSeaListingLikeEvent, chain: string): NormalizedListing | null {
        const nft = event.nft || event.asset;
        const contract = nft?.contract;
        const timestamp = event.event_timestamp ?? event.closing_date;
        if (!contract || !timestamp) return null;

        const priceNative = paymentToNative(event.payment);
        const tokenPart = nft?.identifier ?? event.order_hash ?? '0';
        const eventId = ['opensea', chain, 'listing', contract.toLowerCase(), String(timestamp), tokenPart].join(
            ':',
        );

        return {
            eventId,
            chain,
            contract: contract.toLowerCase(),
            tokenId: nft?.identifier,
            timestamp,
            maker: (event.seller ?? '').toLowerCase(),
            priceNative,
            currency: event.payment?.symbol ?? 'ETH',
            marketplace: 'OpenSea',
            raw: event,
        };
    }

    private normalize(event: OpenSeaEvent, chain: string): NormalizedSale | null {
        const txHash = event.transaction;
        const nft = event.nft || event.asset;
        const contract = nft?.contract;
        const timestamp = event.event_timestamp ?? event.closing_date;
        if (!txHash || !contract || !timestamp) return null;

        const priceNative = paymentToNative(event.payment);
        const eventId = [
            'opensea',
            chain,
            txHash.toLowerCase(),
            event.order_hash ?? nft?.identifier ?? '0',
        ].join(':');

        return {
            eventId,
            chain,
            contract: contract.toLowerCase(),
            tokenId: nft?.identifier,
            txHash,
            timestamp,
            buyer: (event.buyer ?? '').toLowerCase(),
            seller: (event.seller ?? '').toLowerCase(),
            priceNative,
            currency: event.payment?.symbol ?? 'ETH',
            marketplace: 'OpenSea',
            raw: event,
        };
    }
}

function paymentToNative(p: OpenSeaPayment | undefined): number {
    if (!p?.quantity) return 0;
    const decimals = p.decimals ?? 18;
    try {
        return Number(BigInt(p.quantity)) / Math.pow(10, decimals);
    } catch {
        return 0;
    }
}

function extractCollectionSlug(collection: OpenSeaContractResponse['collection']): string | null {
    if (typeof collection === 'string' && collection.trim()) return collection.trim();
    if (collection && typeof collection === 'object' && 'slug' in collection) {
        const s = (collection as { slug?: string }).slug;
        if (s?.trim()) return s.trim();
    }
    return null;
}

function extractFloorFromStats(data: OpenSeaCollectionStatsResponse | undefined): number | null {
    if (!data) return null;
    const raw =
        data.stats?.floor_price ??
        data.stats?.total?.floor_price ??
        data.total?.floor_price ??
        data.floor_price;
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
}
