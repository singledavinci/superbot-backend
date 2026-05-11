import type { PrismaClient } from '@superbot/database';

export class ProviderHealthManager {
    constructor(private prisma: PrismaClient) {}

    async record(args: {
        providerName: string;
        providerType: string;
        chainId: number;
        status: string;
        latencyMs?: number;
        error?: boolean;
    }): Promise<void> {
        const prev = await this.prisma.mintProviderHealth.findUnique({
            where: { providerName_chainId: { providerName: args.providerName, chainId: args.chainId } },
        });
        const errCount = (prev?.errorCount ?? 0) + (args.error ? 1 : 0);
        await this.prisma.mintProviderHealth.upsert({
            where: { providerName_chainId: { providerName: args.providerName, chainId: args.chainId } },
            create: {
                providerName: args.providerName,
                providerType: args.providerType,
                chainId: args.chainId,
                status: args.status,
                latencyMs: args.latencyMs ?? null,
                errorCount: args.error ? 1 : 0,
                lastSuccessAt: args.error ? null : new Date(),
                lastFailureAt: args.error ? new Date() : null,
                updatedAt: new Date(),
            },
            update: {
                status: args.status,
                latencyMs: args.latencyMs ?? undefined,
                errorCount: errCount,
                lastSuccessAt: args.error ? undefined : new Date(),
                lastFailureAt: args.error ? new Date() : undefined,
                updatedAt: new Date(),
            },
        });
    }
}
