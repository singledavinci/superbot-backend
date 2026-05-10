import { WebSocketProvider, id, Log, Interface, zeroPadValue } from 'ethers';
import { eventQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import * as dotenv from 'dotenv';

dotenv.config();

// Event Signatures
const ERC721_TRANSFER_SIG = id("Transfer(address,address,uint256)");
const ERC1155_TRANSFER_SINGLE_SIG = id("TransferSingle(address,address,address,uint256,uint256)");
const ERC1155_TRANSFER_BATCH_SIG = id("TransferBatch(address,address,address,uint256[],uint256[])");

export interface ChainConfig {
    name: string;
    rpcEnvKey: string;
}

export class BlockchainIndexer {
    private providers: Map<string, WebSocketProvider> = new Map();
    private activeSubscriptions: Map<string, any[]> = new Map();
    private reconnectAttempts: Map<string, number> = new Map();
    private CONFIRMATION_BLOCKS = Number(process.env.CONFIRMATION_BLOCKS) || 2;
    
    // Ethereum-only deployment. To re-enable additional chains, add entries here
    // and set the corresponding *_WSS_RPC_URL env vars.
    private supportedChains: ChainConfig[] = [
        { name: 'ethereum', rpcEnvKey: 'WSS_RPC_URL' },
    ];

    constructor() {
        for (const chain of this.supportedChains) {
            const rpcUrl = process.env[chain.rpcEnvKey];
            if (rpcUrl) {
                this.createProviderForChain(chain.name, rpcUrl);
            }
        }

        if (this.providers.size === 0) {
            console.warn('⚠️ No valid WSS RPC URLs found or all failed to connect! Indexer will not receive live events.');
        }
    }

    /**
     * Create a WebSocketProvider for a chain and *immediately* attach all error/close/open
     * handlers so a transient 429 / network error during connection cannot escape as an
     * unhandled `error` event and crash the process.
     */
    private createProviderForChain(chainName: string, rpcUrl: string): WebSocketProvider | null {
        try {
            const provider = new WebSocketProvider(rpcUrl);
            this.providers.set(chainName, provider);
            this.attachManagementListeners(chainName, provider);
            return provider;
        } catch (error) {
            console.error(`❌ Failed to initialize provider for ${chainName}:`, error);
            // Schedule a retry so transient issues at startup are not fatal
            const attempts = this.reconnectAttempts.get(chainName) || 0;
            const delay = Math.min(30000 * Math.pow(2, attempts), 300000);
            this.reconnectAttempts.set(chainName, attempts + 1);
            setTimeout(() => this.createProviderForChain(chainName, rpcUrl), delay);
            return null;
        }
    }

    public async start() {
        console.log(`📡 Starting Blockchain Indexer (${this.providers.size} chain(s) active: ${[...this.providers.keys()].join(', ') || 'none'})...`);
        
        // 1. Initialize Sync State and perform Backfills
        for (const [chainName, provider] of this.providers.entries()) {
            try {
                const currentBlock = await provider.getBlockNumber();
                const syncState = await prisma.syncState.findUnique({ where: { chain: chainName } });
                
                // We backfill if we have a record and it's behind
                if (syncState && syncState.lastBlock < currentBlock - this.CONFIRMATION_BLOCKS) {
                    const fromBlock = syncState.lastBlock + 1;
                    const toBlock = currentBlock - this.CONFIRMATION_BLOCKS;
                    console.log(`[Indexer] ⏳ Backfilling ${chainName}: ${fromBlock} -> ${toBlock}`);
                    await this.backfill(chainName, fromBlock, toBlock);
                } else if (!syncState) {
                    // Initialize state for new chains
                    await prisma.syncState.create({
                        data: { chain: chainName, lastBlock: currentBlock - this.CONFIRMATION_BLOCKS }
                    });
                }
            } catch (err) {
                console.error(`[Indexer] Failed to initialize sync for ${chainName}:`, err);
            }
        }

        // 2. Initial filter setup for live events
        await this.refreshFilters();

        // 3. Periodic tasks
        setInterval(() => this.refreshFilters(), 5 * 60 * 1000); // Refresh filters
        
        // Persist last block every minute
        setInterval(async () => {
            for (const [chainName, provider] of this.providers.entries()) {
                try {
                    const latest = await provider.getBlockNumber();
                    await prisma.syncState.update({
                        where: { chain: chainName },
                        data: { lastBlock: latest - this.CONFIRMATION_BLOCKS }
                    });
                } catch (e) {}
            }
        }, 60000);
    }

    private async backfill(chainName: string, from: number, to: number) {
        console.log(`[Indexer] 🏗️ Backfill logic for ${chainName} would fetch logs from ${from} to ${to}`);
        // In a real production environment, we would use provider.getLogs here.
        // For MVP, we mark the state as caught up.
    }

    private async refreshFilters() {
        const disableGlobal = process.env.DISABLE_GLOBAL_SCAN === 'true';
        
        // 1. Fetch all tracked targets from DB
        const wallets = await prisma.trackedWallet.findMany({ select: { address: true } });
        const collections = await prisma.trackedCollection.findMany({ select: { contractAddress: true } });

        const walletAddresses = wallets.map(w => zeroPadValue(w.address.toLowerCase(), 32));
        const collectionAddresses = collections.map(c => c.contractAddress.toLowerCase());

        console.log(`[Indexer] Refreshing filters: ${wallets.length} wallets, ${collections.length} collections. Global Scan: ${!disableGlobal}`);

        for (const [chainName, provider] of this.providers.entries()) {
            // Remove old listeners
            provider.removeAllListeners();
            
            if (!disableGlobal) {
                // FIREHOSE MODE: Listen to EVERYTHING (High credit cost)
                this.setupSubscription(chainName, provider, { topics: [[ERC721_TRANSFER_SIG, ERC1155_TRANSFER_SINGLE_SIG, ERC1155_TRANSFER_BATCH_SIG]] });
            } else {
                // SMART MODE: Only listen to what we care about
                if (collectionAddresses.length > 0) {
                    this.setupSubscription(chainName, provider, {
                        address: collectionAddresses,
                        topics: [[ERC721_TRANSFER_SIG, ERC1155_TRANSFER_SINGLE_SIG, ERC1155_TRANSFER_BATCH_SIG]]
                    });
                }

                if (walletAddresses.length > 0) {
                    // Track ERC-721
                    this.setupSubscription(chainName, provider, { topics: [ERC721_TRANSFER_SIG, null, walletAddresses] });
                    this.setupSubscription(chainName, provider, { topics: [ERC721_TRANSFER_SIG, walletAddresses] });
                    
                    // Track ERC-1155
                    this.setupSubscription(chainName, provider, { topics: [ERC1155_TRANSFER_SINGLE_SIG, null, null, walletAddresses] });
                    this.setupSubscription(chainName, provider, { topics: [ERC1155_TRANSFER_SINGLE_SIG, null, walletAddresses] });
                }
            }

            // Re-attach error/close handlers (idempotent — guarded by __superbotListenersAttached flag)
            this.attachManagementListeners(chainName, provider);
        }
    }

    private setupSubscription(chainName: string, provider: WebSocketProvider, filter: any) {
        const iface = new Interface([
            "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
            "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"
        ]);

        provider.on(filter, async (log: Log) => {
            try {
                const eventId = `${chainName}-${log.transactionHash}-${log.index}`;
                let eventData: any = {
                    eventId,
                    chain: chainName,
                    contract: log.address.toLowerCase(),
                    txHash: log.transactionHash,
                    blockNumber: log.blockNumber
                };

                if (log.topics[0] === ERC721_TRANSFER_SIG && log.topics.length === 4) {
                    eventData.type = 'erc721_transfer';
                    eventData.from = `0x${log.topics[1].slice(26)}`.toLowerCase();
                    eventData.to = `0x${log.topics[2].slice(26)}`.toLowerCase();
                    eventData.tokenId = BigInt(log.topics[3]).toString();
                } else if (log.topics[0] === ERC1155_TRANSFER_SINGLE_SIG) {
                    eventData.type = 'erc1155_transfer';
                    const decoded = iface.decodeEventLog("TransferSingle", log.data, log.topics);
                    eventData.from = decoded.from.toLowerCase();
                    eventData.to = decoded.to.toLowerCase();
                    eventData.tokenId = decoded.id.toString();
                    eventData.value = decoded.value.toString();
                }

                if (eventData.type) {
                    // Reorg protection: delay delivery based on CONFIRMATION_BLOCKS
                    const delayMs = this.CONFIRMATION_BLOCKS * 12000;
                    
                    await eventQueue.add('nft_transfer', eventData, { 
                        jobId: eventId,
                        delay: delayMs
                    });
                }
            } catch (error) {
                // Ignore parse errors
            }
        });
    }

    private attachManagementListeners(chainName: string, provider: WebSocketProvider) {
        // Try to grab the underlying WS now; if not yet ready, poll briefly so we never
        // miss attaching an 'error' listener (which would crash the process if unhandled).
        const tryAttach = (attempt = 0): void => {
            const ws = (provider as any).websocket;
            if (!ws) {
                if (attempt < 20) {
                    setTimeout(() => tryAttach(attempt + 1), 50);
                } else {
                    console.warn(`[Indexer] Could not access websocket for ${chainName} after waiting; relying on process-level guard.`);
                }
                return;
            }

            // Guard against double-attaching listeners on reconnect
            if ((ws as any).__superbotListenersAttached) return;
            (ws as any).__superbotListenersAttached = true;

            ws.on('error', (err: any) => {
                const msg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
                console.error(`❌ WebSocket error for ${chainName}:`, msg);

                if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
                    console.warn(`🚨 [Indexer] RATE LIMIT DETECTED on ${chainName}. Set DISABLE_GLOBAL_SCAN=true to reduce RPC load.`);
                }
            });

            ws.on('close', () => {
                const attempts = this.reconnectAttempts.get(chainName) || 0;
                const delay = Math.min(30000 * Math.pow(2, attempts), 300000); // Max 5 mins

                console.error(`❌ WebSocket disconnected for ${chainName}! Reconnecting in ${delay / 1000}s... (Attempt ${attempts + 1})`);

                setTimeout(() => {
                    this.reconnectAttempts.set(chainName, attempts + 1);
                    const rpcUrl = process.env[this.supportedChains.find(c => c.name === chainName)?.rpcEnvKey || ''];
                    if (rpcUrl) {
                        const newProvider = this.createProviderForChain(chainName, rpcUrl);
                        if (newProvider) {
                            this.refreshFilters();
                        }
                    }
                }, delay);
            });

            ws.on('open', () => {
                console.log(`✅ WebSocket connected for ${chainName}`);
                this.reconnectAttempts.set(chainName, 0);
            });
        };

        tryAttach();
    }
}

if (require.main === module) {
    const indexer = new BlockchainIndexer();
    indexer.start().catch(err => {
        console.error('❌ Failed to start Blockchain Indexer:', err);
        process.exit(1);
    });
}
