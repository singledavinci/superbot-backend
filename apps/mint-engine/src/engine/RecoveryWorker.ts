import type { PrismaClient } from '@superbot/database';
import { mintEnv } from '../config/mintEnv';

export class RecoveryWorker {
    constructor(private prisma: PrismaClient) {}

    async reconcileOnStartup(): Promise<number> {
        const pending = await this.prisma.mintJob.findMany({
            where: {
                status: { in: ['submitted', 'pending', 'nonce_locked', 'signed'] },
            },
            take: 500,
        });
        let n = 0;
        for (const j of pending) {
            await this.prisma.mintAuditLog.create({
                data: {
                    mintJobId: j.id,
                    guildId: j.guildId,
                    userId: j.userId,
                    action: 'recovery_mark',
                    status: j.status,
                    message: 'Seen on mint-engine startup',
                },
            });
            n++;
        }
        if (mintEnv.MINT_BACKTEST_MODE) {
            /* skip mutating live nonce locks in backtest */
        }
        return n;
    }
}
