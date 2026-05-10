import IORedis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
});

import { Queue } from 'bullmq';

export const eventQueue = new Queue('blockchain_events', { connection: redisConnection });
export const discordQueue = new Queue('discord_delivery', { connection: redisConnection });

/** Delayed floor before/after checks for mass listing / mass delist alerts. */
export const floorImpactQueue = new Queue('floor_impact', { connection: redisConnection });

