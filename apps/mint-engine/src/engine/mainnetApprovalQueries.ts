import type { PrismaClient } from '@superbot/database';

export type MainnetApprovalRow = {
    id: string;
    guildId: string;
    userId: string;
    mintWalletId: string;
    walletAddress: string;
    chainId: number;
    approvalStatus: string;
    expiresAt: Date;
    maxFeePerGas: string | null;
    maxPriorityFeePerGas: string | null;
    maxTotalCostNative: string | null;
    maxQuantity: number;
    allowedCollections: unknown;
};

/**
 * Active, non-expired approval for wallet+guild+user. Caller must still match collection allow-list.
 */
export async function findActiveMainnetApproval(
    prisma: PrismaClient,
    args: { userId: string; guildId: string; mintWalletId: string },
): Promise<MainnetApprovalRow | null> {
    const now = new Date();
    const row = await prisma.mainnetExecutionApproval.findFirst({
        where: {
            userId: args.userId,
            guildId: args.guildId,
            mintWalletId: args.mintWalletId,
            approvalStatus: 'active',
            expiresAt: { gt: now },
        },
        orderBy: { expiresAt: 'desc' },
        select: {
            id: true,
            guildId: true,
            userId: true,
            mintWalletId: true,
            walletAddress: true,
            chainId: true,
            approvalStatus: true,
            expiresAt: true,
            maxFeePerGas: true,
            maxPriorityFeePerGas: true,
            maxTotalCostNative: true,
            maxQuantity: true,
            allowedCollections: true,
        },
    });
    return row;
}

export function collectionAllowedByApproval(allowedCollections: unknown, collectionLower: string): boolean {
    if (allowedCollections == null) return true;
    if (!Array.isArray(allowedCollections)) return true;
    const list = allowedCollections.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
    if (list.length === 0) return true;
    return list.includes(collectionLower);
}
