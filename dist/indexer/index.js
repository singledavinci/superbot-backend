"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlockchainIndexer = void 0;
const ethers_1 = require("ethers");
const queue_1 = require("../queue");
const dotenv = __importStar(require("dotenv"));
dotenv.config();
// ERC721 Transfer Event Signature
const TRANSFER_EVENT_SIG = (0, ethers_1.id)("Transfer(address,address,uint256)");
class BlockchainIndexer {
    providers = new Map();
    supportedChains = [
        { name: 'ethereum', rpcEnvKey: 'WSS_RPC_URL' },
        { name: 'polygon', rpcEnvKey: 'POLYGON_WSS_RPC_URL' },
        { name: 'base', rpcEnvKey: 'BASE_WSS_RPC_URL' }
    ];
    constructor() {
        for (const chain of this.supportedChains) {
            const rpcUrl = process.env[chain.rpcEnvKey];
            if (rpcUrl) {
                this.providers.set(chain.name, new ethers_1.WebSocketProvider(rpcUrl));
            }
            else {
                console.warn(`[Indexer] Skipping ${chain.name} - ${chain.rpcEnvKey} is not set in .env`);
            }
        }
        if (this.providers.size === 0) {
            console.warn('⚠️ No WSS RPC URLs found in .env! Indexer will not receive live events.');
        }
    }
    async start() {
        console.log(`📡 Starting Multi-Chain Blockchain Indexer (${this.providers.size} chains active)...`);
        for (const [chainName, provider] of this.providers.entries()) {
            this.attachProviderListeners(chainName, provider);
        }
    }
    attachProviderListeners(chainName, provider) {
        console.log(`[Indexer] Connecting to ${chainName}...`);
        provider.on({ topics: [TRANSFER_EVENT_SIG] }, async (log) => {
            try {
                if (log.topics.length === 4) {
                    const contract = log.address.toLowerCase();
                    const from = `0x${log.topics[1].slice(26)}`.toLowerCase();
                    const to = `0x${log.topics[2].slice(26)}`.toLowerCase();
                    const tokenId = BigInt(log.topics[3]).toString();
                    const eventId = `${chainName}-${log.transactionHash}-${log.index}`;
                    await queue_1.eventQueue.add('nft_transfer', {
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
            }
            catch (error) {
                // Ignore parse errors on malformed logs
            }
        });
        provider.websocket.on('close', () => {
            console.error(`❌ WebSocket disconnected for ${chainName}! Initiating reconnect...`);
            setTimeout(() => {
                // Re-initialize provider
                const rpcUrl = process.env[this.supportedChains.find(c => c.name === chainName)?.rpcEnvKey || ''];
                if (rpcUrl) {
                    const newProvider = new ethers_1.WebSocketProvider(rpcUrl);
                    this.providers.set(chainName, newProvider);
                    this.attachProviderListeners(chainName, newProvider);
                }
            }, 5000);
        });
        console.log(`✅ Indexer successfully attached to ${chainName} WebSocket`);
    }
}
exports.BlockchainIndexer = BlockchainIndexer;
