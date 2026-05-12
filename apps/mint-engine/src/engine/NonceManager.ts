import type { Prisma, PrismaClient } from '@superbot/database';
import type { JsonRpcProvider } from 'ethers';
import type IORedis from 'ioredis';

const REDIS_MIRROR_PREFIX = 'mint:nonce:mirror:';

export class NonceManager {
    constructor(
        private prisma: PrismaClient,
        private redis: IORedis | null,
    ) {}

    /** Postgres is source of truth; Redis mirrors for fast checks. */
    async acquireLockTx(args: {
        chainId: number;
        walletAddress: string;
        nonce: string;
        mintJobId: string;
    }): Promise<{ ok: true } | { ok: false; code: string }> {
        const wallet = args.walletAddress.toLowerCase();
        try {
            await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
                await tx.nonceLock.create({
                    data: {
                        chainId: args.chainId,
                        walletAddress: wallet,
                        nonce: args.nonce,
                        status: 'locked',
                        mintJobId: args.mintJobId,
                    },
                });
            });
        } catch {
            return { ok: false, code: 'NONCE_LOCK_CONFLICT' };
        }
        if (this.redis) {
            const key = `${REDIS_MIRROR_PREFIX}${args.chainId}:${wallet}:${args.nonce}`;
            await this.redis.set(key, args.mintJobId, 'EX', 600);
        }
        return { ok: true };
    }

    /** Same uniqueness as real lock, but status `simulated` for mainnet dry-run (no broadcast). */
    async acquireSimulatedLockTx(args: {
        chainId: number;
        walletAddress: string;
        nonce: string;
        mintJobId: string;
    }): Promise<{ ok: true } | { ok: false; code: string }> {
        const wallet = args.walletAddress.toLowerCase();
        try {
            await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
                await tx.nonceLock.create({
                    data: {
                        chainId: args.chainId,
                        walletAddress: wallet,
                        nonce: args.nonce,
                        status: 'simulated',
                        mintJobId: args.mintJobId,
                        metadataJson: { kind: 'mainnet_dry_run' } as object,
                    },
                });
            });
        } catch {
            return { ok: false, code: 'NONCE_LOCK_CONFLICT' };
        }
        return { ok: true };
    }

    async markReplacing(mintJobId: string): Promise<void> {
        await this.prisma.nonceLock.updateMany({
            where: { mintJobId, status: 'submitted' },
            data: { status: 'replacing' },
        });
    }

    async getPendingNonce(provider: JsonRpcProvider, walletAddress: string): Promise<number> {
        const n = await provider.getTransactionCount(walletAddress, 'pending');
        return Number(n);
    }

    /** Terminal states release the logical lock (Postgres is source of truth). */
    async finalizeLock(
        mintJobId: string,
        terminalStatus: 'confirmed' | 'failed' | 'cancelled' | 'released',
    ): Promise<void> {
        await this.prisma.nonceLock.updateMany({
            where: { mintJobId, status: { in: ['locked', 'submitted', 'replacing', 'simulated'] } },
            data: { status: terminalStatus, releasedAt: new Date() },
        });
    }

    async reconcileRedisFromDb(chainId: number, wallet: string, nonce: string): Promise<void> {
        if (!this.redis) return;
        const w = wallet.toLowerCase();
        const row = await this.prisma.nonceLock.findFirst({
            where: { chainId, walletAddress: w, nonce },
            orderBy: { lockedAt: 'desc' },
        });
        const key = `${REDIS_MIRROR_PREFIX}${chainId}:${w}:${nonce}`;
        if (!row || ['confirmed', 'replaced', 'dropped', 'cancelled', 'released', 'expired'].includes(row.status)) {
            await this.redis.del(key);
        } else {
            await this.redis.set(key, row.mintJobId, 'EX', 600);
        }
    }
}
