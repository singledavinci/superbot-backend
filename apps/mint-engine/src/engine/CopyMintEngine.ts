import type { CopyMintConfig } from '@prisma/client';
import type { PrismaClient } from '@superbot/database';

export class CopyMintEngine {
    constructor(private prisma: PrismaClient) {}

    async listConfigs(guildId: string, userId: string) {
        return this.prisma.copyMintConfig.findMany({ where: { guildId, userId } });
    }

    async upsertConfig(data: {
        id?: string;
        guildId: string;
        userId: string;
        trackedWalletAddress: string;
        targetCollectionAddress?: string | null;
        mode: string;
        executionWalletId: string;
        quantity: number;
        enabled: boolean;
    }): Promise<CopyMintConfig | null> {
        if (data.id) {
            const existing = await this.prisma.copyMintConfig.findFirst({
                where: { id: data.id, guildId: data.guildId, userId: data.userId },
            });
            if (!existing) return null;
            return this.prisma.copyMintConfig.update({
                where: { id: data.id },
                data: {
                    trackedWalletAddress: data.trackedWalletAddress.toLowerCase(),
                    targetCollectionAddress: data.targetCollectionAddress?.toLowerCase() ?? null,
                    mode: data.mode,
                    executionWalletId: data.executionWalletId,
                    quantity: data.quantity,
                    enabled: data.enabled,
                },
            });
        }
        return this.prisma.copyMintConfig.create({
            data: {
                guildId: data.guildId,
                userId: data.userId,
                trackedWalletAddress: data.trackedWalletAddress.toLowerCase(),
                targetCollectionAddress: data.targetCollectionAddress?.toLowerCase() ?? null,
                mode: data.mode,
                executionWalletId: data.executionWalletId,
                quantity: data.quantity,
                enabled: data.enabled,
            },
        });
    }
}
