import { JsonRpcProvider, Interface, Log } from 'ethers';

export interface SaleInfo {
    isSale: boolean;
    price?: string;
    currency?: string;
    marketplace?: string;
}

/** Pooled HTTPS RPC — worker wires this to RpcPool methods to round-robin and track 429s. */
export interface PooledHttpsSource {
    getHttpsProvider(): JsonRpcProvider;
    markHttpsSuccess(provider: JsonRpcProvider): void;
    markHttps429(provider: JsonRpcProvider): void;
}

const RPC_RECEIPT_TIMEOUT_MS =
    typeof process.env.HTTPS_RPC_JSON_TIMEOUT_MS !== 'undefined' &&
    !Number.isNaN(Number(process.env.HTTPS_RPC_JSON_TIMEOUT_MS))
        ? Number(process.env.HTTPS_RPC_JSON_TIMEOUT_MS)
        : 25_000;

function isLikely429(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /429/.test(msg) || /\brate limit\b/i.test(msg);
}

function isRetryableForFailover(e: unknown): boolean {
    if (isLikely429(e)) return true;
    const msg = e instanceof Error ? e.message : String(e);
    if (/50[0-9]/.test(msg)) return true;
    if (/rpc_timeout\b/i.test(msg)) return false;
    const code = (e as { code?: string })?.code;
    return code === 'SERVER_ERROR';
}

export type SaleDetectorRpcInput = string | PooledHttpsSource;

export class SaleDetector {
    private readonly pooled: PooledHttpsSource | null;
    private readonly fixedProvider: JsonRpcProvider | null;
    private readonly openseaIface: Interface;
    private readonly blurIface: Interface;

    constructor(rpcUrlOrPool: SaleDetectorRpcInput) {
        if (typeof rpcUrlOrPool === 'string') {
            this.pooled = null;
            this.fixedProvider =
                rpcUrlOrPool.trim().length > 0 ? new JsonRpcProvider(rpcUrlOrPool.trim()) : null;
        } else {
            this.pooled = rpcUrlOrPool;
            this.fixedProvider = null;
        }

        this.openseaIface = new Interface([
            'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
        ]);

        this.blurIface = new Interface([
            'event Execution721(address maker, address taker, address collection, uint256 tokenId, uint256 price)',
        ]);
    }

    private async timedGetReceipt(provider: JsonRpcProvider, txHash: string) {
        return await Promise.race([
            provider.getTransactionReceipt(txHash),
            new Promise<null>((_, rej) =>
                setTimeout(() => rej(new Error('SaleDetector.rpc_timeout')), RPC_RECEIPT_TIMEOUT_MS),
            ),
        ]);
    }

    /**
     * Detects if a transfer was part of a verified sale by inspecting the transaction logs.
     * With a {@link PooledHttpsSource}, performs one failover retry on 429 / 5xx / SERVER_ERROR.
     */
    public async detectSale(txHash: string): Promise<SaleInfo> {
        const maxAttempts = this.pooled ? 2 : 1;
        let lastErr: unknown;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let provider: JsonRpcProvider | null = this.fixedProvider;
            if (this.pooled) {
                provider = this.pooled.getHttpsProvider();
            }
            if (!provider) return { isSale: false };

            try {
                const receipt = await this.timedGetReceipt(provider, txHash);
                if (!receipt) {
                    return { isSale: false };
                }

                const out = this.parseReceiptLogs(receipt.logs);

                if (this.pooled) {
                    this.pooled.markHttpsSuccess(provider);
                }

                return out;
            } catch (error) {
                lastErr = error;
                if (this.pooled && isLikely429(error)) {
                    this.pooled.markHttps429(provider);
                }

                const canRetry =
                    this.pooled &&
                    attempt + 1 < maxAttempts &&
                    isRetryableForFailover(error) &&
                    !(error instanceof Error && /rpc_timeout/i.test(error.message));

                if (!canRetry) {
                    console.error(`[SaleDetector] Error detecting sale for ${txHash}:`, error);
                    return { isSale: false };
                }
            }
        }

        console.error(`[SaleDetector] Error detecting sale for ${txHash}:`, lastErr);
        return { isSale: false };
    }

    private parseReceiptLogs(logs: readonly Log[]): SaleInfo {
        for (const log of logs) {
            try {
                const decoded = this.openseaIface.parseLog(log as Log);
                if (decoded && decoded.name === 'OrderFulfilled') {
                    const ethConsideration = decoded.args.consideration.find(
                        (c: { token: string }) => c.token === '0x0000000000000000000000000000000000000000',
                    );
                    return {
                        isSale: true,
                        price: ethConsideration ? BigInt(ethConsideration.amount).toString() : '0',
                        currency: 'ETH',
                        marketplace: 'OpenSea',
                    };
                }
            } catch {
                //
            }

            try {
                const decoded = this.blurIface.parseLog(log as Log);
                if (decoded && decoded.name === 'Execution721') {
                    return {
                        isSale: true,
                        price: decoded.args.price.toString(),
                        currency: 'ETH',
                        marketplace: 'Blur',
                    };
                }
            } catch {
                //
            }
        }

        return { isSale: false };
    }
}
