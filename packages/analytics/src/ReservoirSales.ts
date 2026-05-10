import axios from 'axios';
import {
    FetchSalesArgs,
    FetchSalesResult,
    NormalizedSale,
    SalesProvider,
} from './SalesProvider';

// Re-export so existing consumers keep working.
export type { NormalizedSale } from './SalesProvider';

interface ReservoirSalesResponse {
    sales: Array<{
        id?: string;
        saleId?: string;
        token?: { contract?: string; tokenId?: string };
        from?: string;
        to?: string;
        txHash?: string;
        timestamp?: number;
        price?: {
            amount?: { native?: number; usd?: number };
            currency?: { symbol?: string };
        };
        orderSource?: string;
        fillSource?: string;
        orderKind?: string;
    }>;
    continuation?: string;
}

const RESERVOIR_BASE = {
    ethereum: 'https://api.reservoir.tools',
    base:     'https://api-base.reservoir.tools',
    polygon:  'https://api-polygon.reservoir.tools',
    arbitrum: 'https://api-arbitrum.reservoir.tools',
    optimism: 'https://api-optimism.reservoir.tools',
} as const;

type SupportedChain = keyof typeof RESERVOIR_BASE;

/**
 * Reservoir-backed normalized NFT sales source.
 *
 * Gated behind `RESERVOIR_API_KEY` and only emits real, provider-sourced
 * events. When no key is configured the provider reports `isConfigured=false`
 * and the SalesIndexer skips it.
 *
 * Cursor format: unix-seconds timestamp string. The indexer stores whatever
 * `nextCursor` the provider returns and passes it back on the next tick.
 */
export class ReservoirSalesClient implements SalesProvider {
    public readonly name = 'reservoir';
    private apiKey: string;

    constructor(apiKey?: string) {
        this.apiKey = apiKey || process.env.RESERVOIR_API_KEY || '';
    }

    public isConfigured(): boolean {
        if (!this.apiKey) return false;
        const v = this.apiKey.trim().toLowerCase();
        if (!v) return false;
        if (v === 'optional_reservoir_key_here') return false;
        if (v.startsWith('placeholder')) return false;
        if (v === 'changeme' || v === 'todo' || v === 'tbd') return false;
        return true;
    }

    public async fetchSales(args: FetchSalesArgs): Promise<FetchSalesResult> {
        if (!this.isConfigured()) return { sales: [] };

        const chain = (args.chain || 'ethereum') as SupportedChain;
        const baseUrl = RESERVOIR_BASE[chain];
        if (!baseUrl) return { sales: [] };

        const limit = Math.min(args.limit ?? 50, 1000);
        const sinceUnix = args.cursor ? Number(args.cursor) : undefined;

        try {
            const response = await axios.get<ReservoirSalesResponse>(`${baseUrl}/sales/v6`, {
                params: {
                    contract: args.contract,
                    limit,
                    startTimestamp: sinceUnix,
                    sortBy: 'time',
                    sortDirection: 'asc',
                },
                headers: { 'x-api-key': this.apiKey },
                timeout: 15_000,
            });

            const items = response.data?.sales ?? [];
            const sales = items
                .map(s => this.normalize(s, chain))
                .filter((s): s is NormalizedSale => s !== null);

            const maxTs = sales.reduce((acc, s) => (s.timestamp > acc ? s.timestamp : acc), sinceUnix ?? 0);

            return {
                sales,
                nextCursor: maxTs ? String(maxTs + 1) : args.cursor,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[ReservoirSalesClient] sales/v6 failed for ${args.contract} (${chain}): ${message}`);
            return { sales: [], nextCursor: args.cursor };
        }
    }

    private normalize(sale: ReservoirSalesResponse['sales'][number], chain: string): NormalizedSale | null {
        const txHash = sale.txHash;
        const timestamp = sale.timestamp;
        const contract = sale.token?.contract;
        if (!txHash || !timestamp || !contract) return null;

        const id = sale.id || sale.saleId || `${txHash}:${sale.token?.tokenId ?? '0'}`;
        const eventId = `reservoir:${chain}:${id}`;

        return {
            eventId,
            chain,
            contract: contract.toLowerCase(),
            tokenId: sale.token?.tokenId,
            txHash,
            timestamp,
            buyer: (sale.to ?? '').toLowerCase(),
            seller: (sale.from ?? '').toLowerCase(),
            priceNative: sale.price?.amount?.native ?? 0,
            priceUsd: sale.price?.amount?.usd,
            currency: sale.price?.currency?.symbol ?? 'ETH',
            marketplace: sale.orderSource || sale.fillSource || sale.orderKind || 'unknown',
            raw: sale,
        };
    }
}
