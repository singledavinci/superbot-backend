import axios from 'axios';
import {
    FetchSalesArgs,
    FetchSalesResult,
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
