import { WebSocketProvider, id, Log, zeroPadValue } from 'ethers';
import { eventQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import * as dotenv from 'dotenv';

dotenv.config();

// ERC721 Transfer Event Signature
const TRANSFER_EVENT_SIG = id("Transfer(address,address,uint256)");

export interface ChainConfig {
    name: string;
    rpcEnvKey: string;
}

export class BlockchainIndexer {
    private providers: Map<string, WebSocketProvider> = new Map();
    private activeSubscriptions: Map<string, any[]> = new Map();
    
    private supportedChains: ChainConfig[] = [
        { name: 'ethereum', rpcEnvKey: 'WSS_RPC_URL' },
        { name: 'polygon', rpcEnvKey: 'POLYGON_WSS_RPC_URL' },
        { name: 'base', rpcEnvKey: 'BASE_WSS_RPC_URL' }
    ];

    constructor() {
        // We always initialize providers now, but we use surgical filters if global scan is off
        for (const chain of this.supportedChains) {
            const rpcUrl = process.env[chain.rpcEnvKey];
            if (rpcUrl) {
                try {
                    this.providers.set(chain.name, new WebSocketProvider(rpcUrl));
                } catch (error) {
                    console.error(`❌ Failed to initialize provider for ${chain.name}:`, error);
                }
            }
        }
        
        if (this.providers.size === 0) {
            console.warn('⚠️ No WSS RPC URLs found in .env! Indexer will not receive live events.');
        }
    }

    public async start() {
        console.log(`📡 Starting Multi-Chain Blockchain Indexer (${this.providers.size} chains active)...`);
        
        // Initial filter setup
        await this.refreshFilters();

        // Refresh filters every 5 minutes to pick up new tracked wallets/collections
        setInterval(() => this.refreshFilters(), 5 * 60 * 1000);
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
                this.setupSubscription(chainName, provider, { topics: [TRANSFER_EVENT_SIG] });
            } else {
                // SMART MODE: Only listen to what we care about
                if (collectionAddresses.length > 0) {
                    this.setupSubscription(chainName, provider, {
                        address: collectionAddresses,
                        topics: [TRANSFER_EVENT_SIG]
                    });
                }

                if (walletAddresses.length > 0) {
                    // Track Buys (to address)
                    this.setupSubscription(chainName, provider, {
                        topics: [TRANSFER_EVENT_SIG, null, walletAddresses]
                    });
                    // Track Sells (from address)
                    this.setupSubscription(chainName, provider, {
                        topics: [TRANSFER_EVENT_SIG, walletAddresses]
                    });
                }
            }

            // Re-attach error/close handlers
            this.attachManagementListeners(chainName, provider);
        }
    }

    private setupSubscription(chainName: string, provider: WebSocketProvider, filter: any) {
        provider.on(filter, async (log: Log) => {
            try {
                if (log.topics.length === 4) { 
                    const contract = log.address.toLowerCase();
                    const from = `0x${log.topics[1].slice(26)}`.toLowerCase();
                    const to = `0x${log.topics[2].slice(26)}`.toLowerCase();
                    const tokenId = BigInt(log.topics[3]).toString();

                    const eventId = `${chainName}-${log.transactionHash}-${log.index}`; 

                    await eventQueue.add('nft_transfer', {
                        eventId,
                        chain: chainName,
                        contract,
                        from,
                        to,
                        tokenId,
                        txHash: log.transactionHash,
                        blockNumber: log.blockNumber
                    }, { jobId: eventId }); 
                }
            } catch (error) {
                // Ignore parse errors
            }
        });
    }

    private attachManagementListeners(chainName: string, provider: WebSocketProvider) {
        const ws = (provider.websocket as any);
        if (!ws) return;

        ws.on('error', (err: any) => {
            const msg = err.message || err.toString();
            console.error(`❌ WebSocket error for ${chainName}:`, msg);
            
            if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
                console.warn(`🚨 [Indexer] RATE LIMIT DETECTED on ${chainName}.`);
                console.warn(`💡 SUGGESTION: Set DISABLE_GLOBAL_SCAN=true in your .env to track only specific targets and save credits.`);
            }
        });

        ws.on('close', () => {
            console.error(`❌ WebSocket disconnected for ${chainName}! Reconnecting in 30s...`);
            setTimeout(() => {
                const rpcUrl = process.env[this.supportedChains.find(c => c.name === chainName)?.rpcEnvKey || ''];
                if (rpcUrl) {
                    const newProvider = new WebSocketProvider(rpcUrl);
                    this.providers.set(chainName, newProvider);
                    this.refreshFilters(); // This will re-attach everything
                }
            }, 30000);
        });
    }
}
