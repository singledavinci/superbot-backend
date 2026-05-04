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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const dotenv = __importStar(require("dotenv"));
const db_1 = require("../db");
dotenv.config();
const redisConnection = new ioredis_1.default(process.env.REDIS_URL || 'redis://localhost:6379');
const eventQueue = new bullmq_1.Queue('blockchain_events', { connection: redisConnection });
async function simulateWhaleBuy() {
    console.log('🐳 Simulating Whale Buy Event...\n');
    try {
        // 1. Seed guild
        const guild = await db_1.prisma.guild.upsert({
            where: { discordId: 'MOCK_GUILD_123' },
            create: { discordId: 'MOCK_GUILD_123', name: 'Test Server' },
            update: { name: 'Test Server' },
        });
        // 2. Seed alert channel
        await db_1.prisma.alertChannel.upsert({
            where: { discordChannelId: 'MOCK_CHANNEL_456' },
            create: { guildId: guild.id, discordChannelId: 'MOCK_CHANNEL_456', name: 'whale-alerts', alertType: 'WHALE_BUY' },
            update: { alertType: 'WHALE_BUY' },
        });
        // 3. Seed tracked whale
        const WHALE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // Vitalik
        await db_1.prisma.trackedWallet.upsert({
            where: { address_guildId: { address: WHALE, guildId: guild.id } },
            create: { guildId: guild.id, address: WHALE, label: 'Vitalik', alertChannelId: 'MOCK_CHANNEL_456', smartMoneyScore: 92, winRate: 0.84, totalFlips: 134 },
            update: { label: 'Vitalik', smartMoneyScore: 92 },
        });
        // 4. Push mock transfer event to queue
        const mockEvent = {
            eventId: `sim-${Date.now()}`,
            chain: 'ethereum',
            contract: '0xBd3531dA5CF5857e7CfAA92426877b022e612cf8', // Pudgy Penguins
            from: '0x1234567890123456789012345678901234567890',
            to: WHALE,
            tokenId: '7771',
            txHash: `0xSIM${Date.now()}`,
            blockNumber: 19_000_000,
        };
        await eventQueue.add('nft_transfer', mockEvent, { jobId: mockEvent.eventId });
        console.log('✅ Whale buy event pushed to BullMQ `blockchain_events` queue!');
        console.log('   Wallet:', WHALE);
        console.log('   Collection: Pudgy Penguins');
        console.log('\n👉 Start the bot in another terminal (`npm run start`) to process this event.');
    }
    catch (e) {
        console.error('❌ Simulation failed:', e);
    }
    finally {
        await db_1.prisma.$disconnect();
        await redisConnection.quit();
    }
}
async function simulateMintRadar() {
    console.log('\n🚀 Simulating Mint Radar (50 rapid mints)...');
    try {
        const CONTRACT = '0xED5AF388653567Af2F388E6224dC7C4b3241C544'; // Azuki
        for (let i = 0; i < 51; i++) {
            await eventQueue.add('nft_transfer', {
                eventId: `mint-sim-${i}-${Date.now()}`,
                chain: 'ethereum',
                contract: CONTRACT,
                from: '0x0000000000000000000000000000000000000000', // Null address = mint
                to: `0xBuyer${i.toString().padStart(40, '0')}`,
                tokenId: `${i}`,
                txHash: `0xMINT${i}`,
                blockNumber: 19_000_001 + i,
            });
        }
        console.log('✅ 51 mint events pushed! Mint Radar should fire at 50.');
    }
    catch (e) {
        console.error('❌ Mint simulation failed:', e);
    }
    finally {
        await redisConnection.quit();
    }
}
(async () => {
    await simulateWhaleBuy();
    await simulateMintRadar();
})();
