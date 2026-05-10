import axios from 'axios';
import {
    FetchFloorArgs,
    FetchFloorResult,
    FetchListingsArgs,
    FetchListingsResult,
    FetchSalesArgs,
    FetchSalesResult,
    NormalizedSale,
    SalesProvider,
} from './SalesProvider';

interface AlchemySaleFee {
    amount?: string;
    tokenAddress?: string;
    symbol?: string;
    decimals?: number;
}

interface AlchemySaleResponseItem {
    marketplace?: string;
    marketplaceAddress?: string;
    contractAddress?: string;
    tokenId?: string;
    quantity?: string;
    buyerAddress?: string;
    sellerAddress?: string;
    taker?: string;
    sellerFee?: AlchemySaleFee;
    protocolFee?: AlchemySaleFee;
    royaltyFee?: AlchemySaleFee;
    blockNumber?: number;
    logIndex?: number;
    bundleIndex?: number;
    transactionHash?: string;
}

interface AlchemySalesResponse {
    nftSales: AlchemySaleResponseItem[];
    pageKey?: string | null;
    validAt?: { blockNumber?: number; blockTimestamp?: string };
}

const ALCHEMY_HOST = {
    ethereum: 'https://eth-mainnet.g.alchemy.com',
} as const;

type SupportedChain = keyof typeof ALCHEMY_HOST;

/**
 * Pulls the API key from `ALCHEMY_API_KEY` first, then falls back to extracting
 * it from `WSS_RPC_URL` (which already encodes the same key). This means the
 * operator only has to set one Alchemy variable to enable both indexing and
 * sales ingestion.
 */
export function resolveAlchemyKey(): string | null {
    const explicit = process.env.ALCHEMY_API_KEY?.trim();
    if (explicit && !isPlaceholder(explicit)) return explicit;

    const wss = process.env.WSS_RPC_URL || '';
    const match = wss.match(/alchemy\.com\/v2\/([^/?#]+)/i);
    if (match) {
        const fromUrl = match[1].trim();
        if (fromUrl && !isPlaceholder(fromUrl)) return fromUrl;
    }
    return null;
}

function isPlaceholder(v: string): boolean {
    const lc = v.toLowerCase();
    return (
        lc === '' ||
        lc.startsWith('placeholder') ||
        lc === 'changeme' ||
        lc === 'todo' ||
        lc === 'tbd' ||
        lc === 'your_api_key'
    );
}

function feeAmountToNative(fee: AlchemySaleFee | undefined): number {
    if (!fee?.amount) return 0;
    const decimals = fee.decimals ?? 18;
    try {
        return Number(BigInt(fee.amount)) / Math.pow(10, decimals);
    } catch {
        return 0;
    }
}

/**
 * Alchemy-backed normalized NFT sales source.
 *
 * Uses the Alchemy NFT API `getNFTSales` endpoint. Cursors are encoded as
 * the last block number we have already ingested; the next poll passes
 * `fromBlock = lastBlock + 1` so we never re-emit a previously seen sale.
 */
export class AlchemySalesClient implements SalesProvider {
    public readonly name = 'alchemy';
    private apiKey: string | null;

    constructor(apiKey?: string) {
        this.apiKey = apiKey ?? resolveAlchemyKey();
    }

    public isConfigured(): boolean {
        return !!this.apiKey;
    }

    public async fetchSales(args: FetchSalesArgs): Promise<FetchSalesResult> {
        if (!this.apiKey) return { sales: [] };

        const chain = (args.chain || 'ethereum').toLowerCase() as SupportedChain;
        const host = ALCHEMY_HOST[chain];
        if (!host) {
            // Refuse silently — caller expected a chain we do not host yet.
            return { sales: [] };
        }

        const limit = Math.min(args.limit ?? 50, 1000);
        const fromBlock = args.cursor ? Number(args.cursor) : undefined;

        try {
            const response = await axios.get<AlchemySalesResponse>(
                `${host}/nft/v3/${this.apiKey}/getNFTSales`,
                {
                    params: {
                        contractAddress: args.contract,
                        fromBlock,
                        order: 'asc',
                        limit,
                    },
                    timeout: 15_000,
                },
            );

            const items = response.data?.nftSales ?? [];
            const sales = items
                .map(item => this.normalize(item, chain))
                .filter((s): s is NormalizedSale => s !== null);

            const maxBlock = sales.reduce(
                (acc, s) => (s.blockNumber && s.blockNumber > acc ? s.blockNumber : acc),
                fromBlock ?? 0,
            );

            return {
                sales,
                nextCursor: maxBlock ? String(maxBlock + 1) : args.cursor,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(
                `[AlchemySalesClient] getNFTSales failed for ${args.contract} (${chain}): ${message}`,
            );
            return { sales: [], nextCursor: args.cursor };
        }
    }

    public async fetchListings(_args: FetchListingsArgs): Promise<FetchListingsResult> {
        return { listings: [] };
    }

    public async fetchFloor(_args: FetchFloorArgs): Promise<FetchFloorResult | null> {
        return null;
    }

    private normalize(
        sale: AlchemySaleResponseItem,
        chain: string,
    ): NormalizedSale | null {
        const txHash = sale.transactionHash;
        const contract = sale.contractAddress;
        if (!txHash || !contract) return null;

        // Total price the buyer paid = seller proceeds + protocol fee + royalty fee.
        const priceNative =
            feeAmountToNative(sale.sellerFee) +
            feeAmountToNative(sale.protocolFee) +
            feeAmountToNative(sale.royaltyFee);

        const eventId = [
            'alchemy',
            chain,
            txHash.toLowerCase(),
            sale.logIndex ?? 0,
            sale.bundleIndex ?? 0,
        ].join(':');

        return {
            eventId,
            chain,
            contract: contract.toLowerCase(),
            tokenId: sale.tokenId,
            txHash,
            blockNumber: sale.blockNumber,
            timestamp: 0, // Alchemy does not return per-sale timestamps.
            buyer: (sale.buyerAddress ?? '').toLowerCase(),
            seller: (sale.sellerAddress ?? '').toLowerCase(),
            priceNative,
            currency: sale.sellerFee?.symbol ?? 'ETH',
            marketplace: sale.marketplace || 'unknown',
            raw: sale,
        };
    }
}
