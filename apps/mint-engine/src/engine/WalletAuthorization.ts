import type { PrismaClient } from '@superbot/database';

export type MintAuthAction = 'preflight' | 'prepare' | 'schedule' | 'live' | 'copy_trigger' | 'cancel' | 'broadcast' | 'sign';

export class WalletAuthorization {
    constructor(private prisma: PrismaClient) {}

    async isAuthorized(args: {
        guildId: string;
        userId: string;
        mintWalletId: string;
        action: MintAuthAction;
    }): Promise<boolean> {
        const row = await this.prisma.mintWalletAuthorization.findFirst({
            where: {
                guildId: args.guildId,
                userId: args.userId,
                mintWalletId: args.mintWalletId,
                revokedAt: null,
            },
        });
        if (!row) return false;
        if (row.permissions.length === 0) return true;
        const map: Record<MintAuthAction, string> = {
            preflight: 'preflight',
            prepare: 'prepare',
            schedule: 'schedule',
            live: 'live',
            copy_trigger: 'copy',
            cancel: 'cancel',
            broadcast: 'live',
            sign: 'live',
        };
        const need = map[args.action];
        return row.permissions.includes(need) || row.permissions.includes('*');
    }

    /** Owner of MintWallet is always authorized for their wallet (bootstrap). */
    async isUserWalletOwner(userId: string, mintWalletId: string): Promise<boolean> {
        const w = await this.prisma.mintWallet.findFirst({
            where: { id: mintWalletId, userId },
        });
        return !!w;
    }

    async canAct(args: {
        guildId: string;
        userId: string;
        mintWalletId: string;
        action: MintAuthAction;
    }): Promise<boolean> {
        if (await this.isUserWalletOwner(args.userId, args.mintWalletId)) return true;
        return this.isAuthorized(args);
    }
}
