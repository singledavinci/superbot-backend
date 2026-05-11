import type { PrismaClient } from '@superbot/database';
import { JsonRpcProvider } from 'ethers';

export class ResultTracker {
    constructor(private prisma: PrismaClient) {}

    async refreshJobFromChain(args: { mintJobId: string; txHash: string; rpcUrl: string }): Promise<void> {
        const p = new JsonRpcProvider(args.rpcUrl);
        const receipt = await p.getTransactionReceipt(args.txHash);
        if (!receipt) return;
        const status = receipt.status === 1 ? 'confirmed' : 'reverted';
        await this.prisma.mintJob.update({
            where: { id: args.mintJobId },
            data: {
                status,
                confirmedAt: receipt.status === 1 ? new Date() : undefined,
                errorCode: receipt.status === 0 ? 'TX_REVERTED' : undefined,
            },
        });
    }
}
