import { WebSocketProvider, Contract, id, Log } from 'ethers';
import { eventQueue } from '../queue';
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
    
    private supportedChains: ChainConfig[] = [
        { name: 'ethereum', rpcEnvKey: 'WSS_RPC_URL' },
        { name: 'polygon', rpcEnvKey: 'POLYGON_WSS_RPC_URL' },
        { name: 'base', rpcEnvKey: 'BASE_WSS_RPC_URL' }
    ];

    constructor() {
        for (const chain of this.supportedChains) {
            const rpcUrl = process.env[chain.rpcEnvKey];
            if (rpcUrl) {
                this.providers.set(chain.name, new WebSocketProvider(rpcUrl));
            } else {
                console.warn(`[Indexer] Skipping ${chain.name} - ${chain.rpcEnvKey} is not set in .env`);
            }
        }
        
        if (this.providers.size === 0) {
            console.warn('⚠️ No WSS RPC URLs found in .env! Indexer will not receive live events.');
        }
    }

    public async start() {
        console.log(`📡 Starting Multi-Chain Blockchain Indexer (${this.providers.size} chains active)...`);

        for (const [chainName, provider] of this.providers.entries()) {
            this.attachProviderListeners(chainName, provider);
        }
    }

    private attachProviderListeners(chainName: string, provider: WebSocketProvider) {
        console.log(`[Indexer] Connecting to ${chainName}...`);

        const disableGlobal = process.env.DISABLE_GLOBAL_SCAN === 'true';

        if (!disableGlobal) {
            provider.on({ topics: [TRANSFER_EVENT_SIG] }, async (log: Log) => {
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
                    // Ignore parse errors on malformed logs
                }
            });
        } else {
            console.log(`[Indexer] Global Scan is DISABLED for ${chainName} (Credit Saving Mode)`);
        }

        const ws = (provider.websocket as any);
        
        ws.on('error', (err: any) => {
            console.error(`❌ WebSocket error for ${chainName}:`, err.message || err);
        });

        ws.on('close', () => {
            console.error(`❌ WebSocket disconnected for ${chainName}! Reconnecting in 30s...`);
            setTimeout(() => {
                const rpcUrl = process.env[this.supportedChains.find(c => c.name === chainName)?.rpcEnvKey || ''];
                if (rpcUrl && rpcUrl.startsWith('wss://')) {
                    const newProvider = new WebSocketProvider(rpcUrl);
                    this.providers.set(chainName, newProvider);
                    this.attachProviderListeners(chainName, newProvider);
                }
            }, 30000);
        });

        console.log(`✅ Indexer successfully attached to ${chainName} WebSocket`);
    }
}
