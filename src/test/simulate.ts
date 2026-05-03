import { Queue } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import { prisma } from '../db';

dotenv.config();

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const eventQueue = new Queue('blockchain_events', { connection: redisConnection });

async function seedDatabase() {
    console.log('🌱 Seeding PostgreSQL Database with Mock Tracked Whale...');
    
    // We need a dummy guild and channel for the alert rule
    const guildId = '123456789012345678';
    const channelId = '987654321098765432';

    // Mock Guild
    await prisma.guild.upsert({
        where: { id: guildId },
        update: {},
        create: {
            id: guildId,
            name: 'Alpha Test Server',
            ownerId: '9999999999'
        }
    });

    // Mock Alert Channel
    await prisma.alertChannel.upsert({
        where: { guildId_channelId: { guildId, channelId } },
        update: {},
        create: {
            guildId,
            channelId,
            purpose: 'whale-watch',
            rolesToPing: []
        }
    });

    // Mock Tracked Wallet (Pranksy or similar famous whale)
    const whaleAddress = '0xd387a6e4e84a6c86bd90c158c6028a58cc8ac459';
    const wallet = await prisma.trackedWallet.upsert({
        where: { address: whaleAddress },
        update: {},
        create: {
            address: whaleAddress,
            label: 'Pranksy',
            globalSmartMoneyScore: 92.5
        }
    });

    // Mock Alert Rule (Route Whale Buys to our Mock Channel)
    // First, find if rule exists to avoid duplicates
    const existingRule = await prisma.alertRule.findFirst({
        where: { targetWalletId: wallet.id, type: 'wallet_buy' }
    });

    if (!existingRule) {
        await prisma.alertRule.create({
            data: {
                guildId,
                channelId,
                type: 'wallet_buy',
                targetWalletId: wallet.id
            }
        });
    }

    console.log('✅ Database seeded with Mock Wallet Rule!');
    return whaleAddress;
}

async function simulateWhaleBuy() {
    try {
        const whaleAddress = await seedDatabase();

        console.log(`🚀 Simulating Whale Buy Event for ${whaleAddress}...`);

        const mockEventId = `mock-tx-${Date.now()}`;
        
        // This simulates what the BlockchainIndexer normally pushes
        await eventQueue.add('nft_transfer', {
            eventId: mockEventId,
            contract: '0xed5af388653567af2f388e6224dc7c4b3241c544', // Azuki
            from: '0x0000000000000000000000000000000000000000', // Mint or seller
            to: whaleAddress, // Pranksy
            tokenId: '4206',
            txHash: mockEventId,
            blockNumber: 17000000
        }, { jobId: mockEventId });

        console.log('✅ Simulated event pushed to BullMQ `blockchain_events` queue!');
        
    } catch (e) {
        console.error('❌ Whale Simulation Failed:', e);
    }
}

async function simulateMintRadar() {
    try {
        console.log(`🚀 Simulating High-Velocity Mint Event...`);

        const contract = '0x8a90cab2b38dba80c64b7734e58ee1db38b8992e'; // Doodles
        const chain = 'ethereum';

        // Mock a Global Mint Alert Rule
        const guildId = '123456789012345678';
        const channelId = '987654321098765432';
        
        await prisma.alertRule.create({
            data: {
                guildId,
                channelId,
                type: 'global_mint'
            }
        });

        // Fire 50 rapid mint events (from Null Address)
        for (let i = 0; i < 50; i++) {
            const mockEventId = `mock-mint-${Date.now()}-${i}`;
            
            await eventQueue.add('nft_transfer', {
                eventId: mockEventId,
                chain,
                contract,
                from: '0x0000000000000000000000000000000000000000', // Null Address = Mint
                to: `0xRandomUser${i}`,
                tokenId: `${i}`,
                txHash: mockEventId,
                blockNumber: 17000000
            }, { jobId: mockEventId });
        }

        console.log('✅ Simulated 50 Mint events pushed to queue!');
        console.log('👉 The bot should trigger exactly ONE Mint Radar alert if velocity exceeds 50/5min.');
    } catch (e) {
        console.error('❌ Mint Simulation Failed:', e);
    }
}

async function run() {
    await simulateWhaleBuy();
    await simulateMintRadar();

    redisConnection.disconnect();
    await prisma.$disconnect();
}

run();
