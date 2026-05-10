import { prisma } from '@superbot/database';
import { discordQueue as discordDeliveryQueue } from '@superbot/queue';
import { redisConnection } from '@superbot/queue';
import { FloorProvider } from '@superbot/analytics';
import * as dotenv from 'dotenv';

dotenv.config();

interface FloorRedisPayload {
    priceNative: number;
    currency: string;
    source?: string;
    ts?: number;
}

interface SnapshotPayload {
    priceNative: number;
    ts: number;
}

export class FloorWorker {
    private floorProvider = new FloorProvider();
    private interval: NodeJS.Timeout | null = null;
    private POLL_INTERVAL = (Number(process.env.FLOOR_POLL_INTERVAL_SECONDS) || 3600) * 1000;

    public async start() {
        console.log(`🕒 Floor Checker started. Polling every ${this.POLL_INTERVAL / 1000}s...`);

        await this.checkFloors();

        this.interval = setInterval(() => {
            this.checkFloors().catch(err => console.error('[FloorWorker] Loop error:', err));
        }, this.POLL_INTERVAL);
    }

    private async checkFloors() {
        const tracked = await prisma.trackedCollection.findMany({
            where: {
                OR: [{ floorAlertPct: { not: null } }, { floorRiseAlertPct: { not: null } }],
            },
        });

        console.log(`[FloorWorker] Checking ${tracked.length} collections for floor movement...`);

        const hourBucket = Math.floor(Date.now() / 3600000);

        for (const item of tracked) {
            try {
                const chain = (item.chain || 'ethereum').toLowerCase();
                if (chain !== 'ethereum') continue;

                const contract = item.contractAddress.toLowerCase();

                let current: FloorRedisPayload | null = null;

                const cached = await redisConnection.get(`floor:${chain}:${contract}`);
                if (cached) {
                    try {
                        current = JSON.parse(cached) as FloorRedisPayload;
                    } catch {
                        current = null;
                    }
                }

                if (!current || !current.priceNative || current.priceNative <= 0) {
                    const data = await this.floorProvider.getFloorPrice(contract, chain);
                    if (!data) continue;
                    current = {
                        priceNative: data.floorPrice,
                        currency: data.currency,
                        source: 'reservoir_fallback',
                        ts: Date.now(),
                    };
                }

                const snapRaw = await redisConnection.get(`floor_snapshot:${chain}:${contract}`);
                let prev: SnapshotPayload | null = null;
                if (snapRaw) {
                    try {
                        prev = JSON.parse(snapRaw) as SnapshotPayload;
                    } catch {
                        prev = null;
                    }
                }

                if (prev && prev.priceNative > 0) {
                    const dropPct = ((prev.priceNative - current.priceNative) / prev.priceNative) * 100;
                    const risePct = ((current.priceNative - prev.priceNative) / prev.priceNative) * 100;

                    if (
                        item.floorAlertPct != null &&
                        dropPct >= item.floorAlertPct &&
                        item.alertChannelId
                    ) {
                        const eventId = `floor-drop:${contract}:${hourBucket}`;
                        await discordDeliveryQueue.add(
                            'discord_alert',
                            {
                                eventId,
                                channelId: item.alertChannelId,
                                alertType: 'FLOOR_DROP',
                                contract,
                                collectionName: item.name,
                                floorPrice: current.priceNative,
                                prevFloor: prev.priceNative,
                                pctChange: dropPct,
                                currency: current.currency,
                                mentionRoleId: item.mentionRoleId,
                            },
                            {
                                jobId: `floor-drop-${item.id}-${hourBucket}`,
                                removeOnComplete: { age: 3600 },
                                removeOnFail: { age: 86400 },
                            },
                        );
                    }

                    if (
                        item.floorRiseAlertPct != null &&
                        risePct >= item.floorRiseAlertPct &&
                        item.alertChannelId
                    ) {
                        const eventId = `floor-rise:${contract}:${hourBucket}`;
                        await discordDeliveryQueue.add(
                            'discord_alert',
                            {
                                eventId,
                                channelId: item.alertChannelId,
                                alertType: 'FLOOR_RISE',
                                contract,
                                collectionName: item.name,
                                floorPrice: current.priceNative,
                                prevFloor: prev.priceNative,
                                pctChange: risePct,
                                currency: current.currency,
                                mentionRoleId: item.mentionRoleId,
                            },
                            {
                                jobId: `floor-rise-${item.id}-${hourBucket}`,
                                removeOnComplete: { age: 3600 },
                                removeOnFail: { age: 86400 },
                            },
                        );
                    }
                }

                await redisConnection.set(
                    `floor_snapshot:${chain}:${contract}`,
                    JSON.stringify({
                        priceNative: current.priceNative,
                        ts: Date.now(),
                    }),
                );
            } catch (error) {
                console.error(`[FloorWorker] Failed ${item.contractAddress}:`, error);
            }
        }
    }
}

if (require.main === module) {
    const worker = new FloorWorker();
    worker.start().catch(err => {
        console.error('❌ Failed to start Floor Worker:', err);
        process.exit(1);
    });
}
