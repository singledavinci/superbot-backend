import { WebSocketProvider, id, Log, Interface, zeroPadValue } from 'ethers';
import { eventQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import { createRpcPoolFromEnv, type RpcPool } from '@superbot/analytics';
import * as dotenv from 'dotenv';

dotenv.config();

/** Bound `getBlockNumber` and similar calls so a stuck RPC cannot hang the indexer. */
const INDEXER_JSONRPC_TIMEOUT_MS =
    Number(process.env.INDEXER_JSONRPC_TIMEOUT_MS) > 0 ? Number(process.env.INDEXER_JSONRPC_TIMEOUT_MS) : 30_000;

async function withJsonRpcTimeout<T>(label: string, promise: Promise<T>, ms = INDEXER_JSONRPC_TIMEOUT_MS): Promise<T> {
    return await Promise.race([
        promise,
        new Promise<T>((_, rej) =>
            setTimeout(() => rej(new Error(`[Indexer] ${label} timed out after ${ms}ms`)), ms),
        ),
    ]);
}

// Event Signatures
const ERC721_TRANSFER_SIG = id('Transfer(address,address,uint256)');
const ERC1155_TRANSFER_SINGLE_SIG = id('TransferSingle(address,address,address,uint256,uint256)');
const ERC1155_TRANSFER_BATCH_SIG = id('TransferBatch(address,address,address,uint256[],uint256[])');

export interface ChainConfig {
    name: string;
    rpcEnvKey: string;
}

export class BlockchainIndexer {
    private providers: Map<string, WebSocketProvider> = new Map();
    private activeSubscriptions: Map<string, any[]> = new Map();
    private reconnectAttempts: Map<string, number> = new Map();
    private CONFIRMATION_BLOCKS = Number(process.env.CONFIRMATION_BLOCKS) || 2;

    /** When set, ethereum WSS rotates through {@link createRpcPoolFromEnv} (WSS_RPC_URLS + WSS_RPC_URL). */
    private ethRpcPool: RpcPool | null = null;
    private ethIndexerPoolMode = false;

    // Ethereum-only deployment. To re-enable additional chains, add entries here
    // and set the corresponding *_WSS_RPC_URL env vars.
    private supportedChains: ChainConfig[] = [{ name: 'ethereum', rpcEnvKey: 'WSS_RPC_URL' }];

    constructor() {
        const pooled = createRpcPoolFromEnv();

        if (pooled && pooled.wssUrls.length > 0) {
            this.ethRpcPool = pooled;
            this.ethIndexerPoolMode = true;
            this.createEthereumProviderFromPool();
        } else {
            this.ethRpcPool = null;
            for (const chain of this.supportedChains) {
                const rpcUrl = process.env[chain.rpcEnvKey];
                if (rpcUrl) {
                    this.createProviderForChainWithUrl(chain.name, rpcUrl);
                }
            }
        }

        if (this.providers.size === 0) {
            console.warn(
                '⚠️ No valid WSS RPC URLs found or all failed to connect! Indexer will not receive live events.',
            );
        }
    }

    /**
     * Create a WebSocketProvider for a chain and *immediately* attach all error/close/open
     * handlers so a transient 429 / network error during connection cannot escape as an
     * unhandled `error` event and crash the process.
     */
    private createProviderForChainWithUrl(chainName: string, rpcUrl: string): WebSocketProvider | null {
        try {
            const provider = new WebSocketProvider(rpcUrl);
            this.providers.set(chainName, provider);
            this.attachManagementListeners(chainName, provider);
            return provider;
        } catch (error) {
            console.error(`❌ Failed to initialize provider for ${chainName}:`, error);
            const attempts = this.reconnectAttempts.get(chainName) || 0;
            const delay = Math.min(30000 * Math.pow(2, attempts), 300000);
            this.reconnectAttempts.set(chainName, attempts + 1);
            setTimeout(() => this.createProviderForChainWithUrl(chainName, rpcUrl), delay);
            return null;
        }
    }

    private createEthereumProviderFromPool(): WebSocketProvider | null {
        if (!this.ethRpcPool) return null;
        try {
            const provider = this.ethRpcPool.getWssProvider();
            this.providers.set('ethereum', provider);
            this.attachManagementListeners('ethereum', provider);
            return provider;
        } catch (error) {
            console.error('❌ Failed to initialize pooled WSS provider for ethereum:', error);
            const attempts = this.reconnectAttempts.get('ethereum') || 0;
            const delay = Math.min(30000 * Math.pow(2, attempts), 300000);
            this.reconnectAttempts.set('ethereum', attempts + 1);
            setTimeout(() => this.createEthereumProviderFromPool(), delay);
            return null;
        }
    }

    public async start() {
        console.log(
            `📡 Starting Blockchain Indexer (${this.providers.size} chain(s) active: ${[...this.providers.keys()].join(', ') || 'none'})...`,
        );

        // 1. Initialize Sync State and perform Backfills
        for (const [chainName, provider] of this.providers.entries()) {
            try {
                const currentBlock = await withJsonRpcTimeout(
                    `${chainName}.getBlockNumber`,
                    provider.getBlockNumber(),
                );
                const syncState = await prisma.syncState.findUnique({ where: { chain: chainName } });

                if (syncState && syncState.lastBlock < currentBlock - this.CONFIRMATION_BLOCKS) {
                    const fromBlock = syncState.lastBlock + 1;
                    const toBlock = currentBlock - this.CONFIRMATION_BLOCKS;
                    console.log(`[Indexer] ⏳ Backfilling ${chainName}: ${fromBlock} -> ${toBlock}`);
                    await this.backfill(chainName, fromBlock, toBlock);
                } else if (!syncState) {
                    await prisma.syncState.create({
                        data: { chain: chainName, lastBlock: currentBlock - this.CONFIRMATION_BLOCKS },
                    });
                }
            } catch (err) {
                console.error(`[Indexer] Failed to initialize sync for ${chainName}:`, err);
            }
        }

        await this.refreshFilters();

        setInterval(() => this.refreshFilters(), 5 * 60 * 1000);

        setInterval(async () => {
            for (const [chainName, provider] of this.providers.entries()) {
                try {
                    const latest = await withJsonRpcTimeout(
                        `${chainName}.getBlockNumber(periodic)`,
                        provider.getBlockNumber(),
                    );
                    await prisma.syncState.update({
                        where: { chain: chainName },
                        data: { lastBlock: latest - this.CONFIRMATION_BLOCKS },
                    });
                } catch {
                    /* best-effort persistence */
                }
            }
        }, 60000);
    }

    private async backfill(chainName: string, from: number, to: number) {
        console.warn(
            `[Indexer] Historical backfill is not implemented (${chainName} blocks ${from}–${to}). Some events in that gap may never be alerted. Confirmation depth=${this.CONFIRMATION_BLOCKS}.`,
        );
        try {
            await prisma.syncState.update({
                where: { chain: chainName },
                data: { lastBlock: to },
            });
        } catch (err) {
            console.warn(`[Indexer] Failed to persist post-backfill checkpoint for ${chainName}:`, err);
        }
    }

    private async refreshFilters() {
        const disableGlobal = process.env.DISABLE_GLOBAL_SCAN === 'true';

        const wallets = await prisma.trackedWallet.findMany({ select: { address: true } });
        const collections = await prisma.trackedCollection.findMany({ select: { contractAddress: true } });

        const walletAddresses = wallets.map(w => zeroPadValue(w.address.toLowerCase(), 32));
        const collectionAddresses = collections.map(c => c.contractAddress.toLowerCase());

        console.log(
            `[Indexer] Refreshing filters: ${wallets.length} wallets, ${collections.length} collections. Global Scan: ${!disableGlobal}`,
        );

        for (const [chainName, provider] of this.providers.entries()) {
            provider.removeAllListeners();

            if (!disableGlobal) {
                this.setupSubscription(chainName, provider, {
                    topics: [[ERC721_TRANSFER_SIG, ERC1155_TRANSFER_SINGLE_SIG, ERC1155_TRANSFER_BATCH_SIG]],
                });
            } else {
                if (collectionAddresses.length > 0) {
                    this.setupSubscription(chainName, provider, {
                        address: collectionAddresses,
                        topics: [[ERC721_TRANSFER_SIG, ERC1155_TRANSFER_SINGLE_SIG, ERC1155_TRANSFER_BATCH_SIG]],
                    });
                }

                if (walletAddresses.length > 0) {
                    this.setupSubscription(chainName, provider, { topics: [ERC721_TRANSFER_SIG, null, walletAddresses] });
                    this.setupSubscription(chainName, provider, { topics: [ERC721_TRANSFER_SIG, walletAddresses] });

                    this.setupSubscription(chainName, provider, {
                        topics: [ERC1155_TRANSFER_SINGLE_SIG, null, null, walletAddresses],
                    });
                    this.setupSubscription(chainName, provider, {
                        topics: [ERC1155_TRANSFER_SINGLE_SIG, null, walletAddresses],
                    });
                }
            }

            this.attachManagementListeners(chainName, provider);
        }
    }

    private setupSubscription(chainName: string, provider: WebSocketProvider, filter: any) {
        const iface = new Interface([
            'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
            'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
        ]);

        provider.on(filter, async (log: Log) => {
            try {
                const eventId = `${chainName}-${log.transactionHash}-${log.index}`;
                const eventData: any = {
                    eventId,
                    chain: chainName,
                    contract: log.address.toLowerCase(),
                    txHash: log.transactionHash,
                    blockNumber: log.blockNumber,
                };

                if (log.topics[0] === ERC721_TRANSFER_SIG && log.topics.length === 4) {
                    eventData.type = 'erc721_transfer';
                    eventData.from = `0x${log.topics[1].slice(26)}`.toLowerCase();
                    eventData.to = `0x${log.topics[2].slice(26)}`.toLowerCase();
                    eventData.tokenId = BigInt(log.topics[3]).toString();
                } else if (log.topics[0] === ERC1155_TRANSFER_SINGLE_SIG) {
                    eventData.type = 'erc1155_transfer';
                    const decoded = iface.decodeEventLog('TransferSingle', log.data, log.topics);
                    eventData.from = decoded.from.toLowerCase();
                    eventData.to = decoded.to.toLowerCase();
                    eventData.tokenId = decoded.id.toString();
                    eventData.value = decoded.value.toString();
                }

                if (eventData.type) {
                    const delayMs = this.CONFIRMATION_BLOCKS * 12000;

                    await eventQueue.add('nft_transfer', eventData, {
                        jobId: eventId,
                        delay: delayMs,
                    });
                }
            } catch {
                // Ignore parse errors
            }
        });
    }

    private attachManagementListeners(chainName: string, provider: WebSocketProvider) {
        const tryAttach = (attempt = 0): void => {
            const ws = (provider as any).websocket;
            if (!ws) {
                if (attempt < 20) {
                    setTimeout(() => tryAttach(attempt + 1), 50);
                } else {
                    console.warn(
                        `[Indexer] Could not access websocket for ${chainName} after waiting; relying on process-level guard.`,
                    );
                }
                return;
            }

            if ((ws as any).__superbotListenersAttached) return;
            (ws as any).__superbotListenersAttached = true;

            ws.on('error', (err: any) => {
                const msg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
                if (this.ethIndexerPoolMode && chainName === 'ethereum' && this.ethRpcPool) {
                    this.ethRpcPool.recordWss429Message(provider, err);
                }
                console.error(`❌ WebSocket error for ${chainName}:`, msg);

                if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
                    console.warn(
                        `🚨 [Indexer] RATE LIMIT DETECTED on ${chainName}. Set DISABLE_GLOBAL_SCAN=true to reduce RPC load.`,
                    );
                }
            });

            ws.on('close', () => {
                const attempts = this.reconnectAttempts.get(chainName) || 0;
                const delay =
                    this.ethIndexerPoolMode && chainName === 'ethereum'
                        ? Math.min(2000 * Math.pow(2, Math.min(attempts, 4)), 30000)
                        : Math.min(30000 * Math.pow(2, attempts), 300000);

                console.error(
                    `❌ WebSocket disconnected for ${chainName}! Reconnecting in ${delay / 1000}s... (Attempt ${attempts + 1})`,
                );

                setTimeout(() => {
                    void this.reconnectAfterClose(chainName, attempts);
                }, delay);
            });

            ws.on('open', () => {
                const label =
                    chainName === 'ethereum' && this.ethRpcPool
                        ? `${this.ethRpcPool.wssLabel(provider)}…`
                        : chainName;
                console.log(`[Indexer] Connected via ${label}`);
                if (this.ethIndexerPoolMode && chainName === 'ethereum' && this.ethRpcPool) {
                    this.ethRpcPool.markWssOpen(provider);
                }
                this.reconnectAttempts.set(chainName, 0);
            });
        };

        tryAttach();
    }

    private async reconnectAfterClose(chainName: string, priorAttempts: number) {
        this.reconnectAttempts.set(chainName, priorAttempts + 1);

        if (chainName === 'ethereum' && this.ethIndexerPoolMode && this.ethRpcPool) {
            const oldProvider = this.providers.get(chainName);
            if (oldProvider) {
                try {
                    await oldProvider.destroy();
                } catch {
                    /* noop */
                }
                this.providers.delete(chainName);
            }
            try {
                const rotated = this.ethRpcPool.rotateWssProvider('disconnect');
                console.log(
                    `[Indexer] Active WSS endpoint (post-rotate): ${this.ethRpcPool.wssLabel(rotated)}…`,
                );
                this.providers.set(chainName, rotated);
                this.attachManagementListeners(chainName, rotated);
                await this.refreshFilters();
            } catch (e) {
                console.error('[Indexer] pooled WSS reconnect failed:', e);
                setTimeout(() => void this.reconnectAfterClose(chainName, priorAttempts + 1), 5000);
            }
            return;
        }

        const rpcUrl = process.env[this.supportedChains.find(c => c.name === chainName)?.rpcEnvKey || ''];
        if (rpcUrl) {
            const newProvider = this.createProviderForChainWithUrl(chainName, rpcUrl);
            if (newProvider) {
                void this.refreshFilters();
            }
        }
    }
}

if (require.main === module) {
    const indexer = new BlockchainIndexer();
    indexer.start().catch(err => {
        console.error('❌ Failed to start Blockchain Indexer:', err);
        process.exit(1);
    });
}
