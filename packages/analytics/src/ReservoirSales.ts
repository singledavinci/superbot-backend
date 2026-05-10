import axios from 'axios';

export interface NormalizedSale {
    eventId: string;        // Stable idempotency key
    chain: string;
    contract: string;
    tokenId?: string;
    txHash: string;
    timestamp: number;      // Unix seconds
    buyer: string;
    seller: string;
    priceNative: number;
    priceUsd?: number;
    currency: string;
    marketplace: string;
    raw: unknown;           // Original provider payload for debugging
}

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
 * This client is intentionally minimal and read-only. It is gated behind
 * `RESERVOIR_API_KEY` and only emits real, provider-sourced events (no
 * synthetic/fake data). When no key is configured, callers should treat
 * the source as unavailable and fall back to on-chain indexing.
 */
export class ReservoirSalesClient {
    private apiKey: string;

    constructor(apiKey?: string) {
        this.apiKey = apiKey || process.env.RESERVOIR_API_KEY || '';
    }

    public isConfigured(): boolean {
        return Boolean(this.apiKey) && this.apiKey !== 'optional_reservoir_key_here';
    }

    /**
     * Fetch normalized sales for a contract since a given unix timestamp.
     * Caller is responsible for persisting `eventId` to dedupe across polls.
     */
    public async fetchSalesForContract(
        contract: string,
        opts: { chain?: SupportedChain; sinceUnix?: number; limit?: number } = {}
    ): Promise<NormalizedSale[]> {
        if (!this.isConfigured()) return [];

        const chain = opts.chain || 'ethereum';
        const baseUrl = RESERVOIR_BASE[chain];
        const limit = Math.min(opts.limit ?? 50, 1000);

        try {
            const response = await axios.get<ReservoirSalesResponse>(`${baseUrl}/sales/v6`, {
                params: {
                    contract,
                    limit,
                    startTimestamp: opts.sinceUnix,
                    sortBy: 'time',
                    sortDirection: 'asc',
                },
                headers: { 'x-api-key': this.apiKey },
                timeout: 15_000,
            });

            const sales = response.data?.sales ?? [];
            return sales
                .map(s => this.normalize(s, chain))
                .filter((s): s is NormalizedSale => s !== null);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[ReservoirSalesClient] sales/v6 failed for ${contract} (${chain}): ${message}`);
            return [];
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
