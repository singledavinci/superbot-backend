import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type { PrismaClient } from '@superbot/database';

/** Schedules delayed BullMQ jobs for preflight timeline (Phase 4+). */
export class MintScheduler {
    constructor(
        private prisma: PrismaClient,
        private connection: IORedis,
        private queueName: string,
    ) {}

    async schedulePreflightChain(args: { mintJobId: string; startTimeMs: number }): Promise<void> {
        const q = new Queue(this.queueName, { connection: this.connection });
        const now = Date.now();
        const delays = [
            { label: 't15m', ms: Math.max(0, args.startTimeMs - now - 15 * 60_000) },
            { label: 't5m', ms: Math.max(0, args.startTimeMs - now - 5 * 60_000) },
            { label: 't1m', ms: Math.max(0, args.startTimeMs - now - 60_000) },
            { label: 't30s', ms: Math.max(0, args.startTimeMs - now - 30_000) },
            { label: 't10s', ms: Math.max(0, args.startTimeMs - now - 10_000) },
        ];
        for (const d of delays) {
            await q.add(
                'preflight_tick',
                { mintJobId: args.mintJobId, tick: d.label },
                { delay: d.ms, jobId: `${args.mintJobId}:${d.label}`.replace(/:/g, '_') },
            );
        }
        await this.prisma.mintJob.update({
            where: { id: args.mintJobId },
            data: { status: 'scheduled' },
        });
    }
}
