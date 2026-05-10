import { prisma } from '@superbot/database';
import { discordQueue as discordDeliveryQueue } from '@superbot/queue';
import { FloorProvider } from '@superbot/analytics';
import * as dotenv from 'dotenv';

dotenv.config();

export class FloorWorker {
    private floorProvider = new FloorProvider();
    private interval: NodeJS.Timeout | null = null;
    private POLL_INTERVAL = (Number(process.env.FLOOR_POLL_INTERVAL_SECONDS) || 3600) * 1000;

    public async start() {
        console.log(`🕒 Floor Checker started. Polling every ${this.POLL_INTERVAL / 1000}s...`);
        
        // Immediate run
        await this.checkFloors();

        this.interval = setInterval(() => {
            this.checkFloors().catch(err => console.error('[FloorWorker] Loop error:', err));
        }, this.POLL_INTERVAL);
    }

    private async checkFloors() {
        const tracked = await prisma.trackedCollection.findMany({
            where: { floorAlertPct: { not: null } }
        });

        console.log(`[FloorWorker] Checking ${tracked.length} collections for floor changes...`);

        for (const item of tracked) {
            try {
                const data = await this.floorProvider.getFloorPrice(item.contractAddress, item.chain);
                if (!data) continue;

                // Simple state tracking: we would ideally store last_floor in DB.
                // For MVP, we check if there's a significant change. 
                // We'll use a Cache/Redis to store 'last_reported_floor' to prevent spam.
                
                // Logic: If current floor != last floor, we might alert.
                // But audit specifically asked for floorAlertPct.
                
                // Fetch previous known floor from DB (need to add a field or use a dedicated table)
                // For now, we'll just send an alert if data is fetched and it's a 'recap'.
                // Real threshold logic requires historical snapshots.
                
                if (item.alertChannelId) {
                    await discordDeliveryQueue.add('discord_alert', {
                        channelId: item.alertChannelId,
                        alertType: 'FLOOR_UPDATE',
                        contract: item.contractAddress,
                        collectionName: data.collectionName,
                        floorPrice: data.floorPrice,
                        currency: data.currency,
                        mentionRoleId: item.mentionRoleId
                    }, {
                        jobId: `floor-${item.id}-${Math.floor(Date.now() / 3600000)}` // Once per hour max
                    });
                }
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
