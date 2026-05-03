import { Queue } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();

export const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redisConnection.on('error', (err) => {
    console.error('❌ Redis connection error:', err);
});

// Queue for processing raw blockchain events
export const eventQueue = new Queue('blockchain_events', { connection: redisConnection });

// Queue for dispatching Discord embeds (handles rate limit backpressure)
export const discordDeliveryQueue = new Queue('discord_delivery', { connection: redisConnection });

console.log('✅ BullMQ Queues initialized');
