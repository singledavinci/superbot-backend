import type { PrismaClient } from '@superbot/database';
import type { TransactionReceipt } from 'ethers';
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

    async pollReceipt(args: { rpcUrl: string; txHash: string; timeoutMs: number; pollMs?: number }): Promise<{
        receipt: TransactionReceipt | null;
        timedOut: boolean;
    }> {
        const p = new JsonRpcProvider(args.rpcUrl);
        const deadline = Date.now() + args.timeoutMs;
        const poll = args.pollMs ?? 2000;
        while (Date.now() < deadline) {
            const r = await p.getTransactionReceipt(args.txHash);
            if (r) return { receipt: r, timedOut: false };
            await new Promise<void>((res) => setTimeout(res, poll));
        }
        return { receipt: null, timedOut: true };
    }

    async applyReceiptToMintRecords(args: {
        mintJobId: string;
        mintTransactionId: string;
        receipt: TransactionReceipt;
        txHash: string;
    }): Promise<void> {
        const st = args.receipt.status;
        const ok = Number(st) === 1;
        const status: string = ok ? 'confirmed' : 'reverted';
        const gasUsed = args.receipt.gasUsed?.toString?.() ?? '';
        const egp =
            args.receipt.gasPrice?.toString?.() ??
            ('effectiveGasPrice' in args.receipt && args.receipt.effectiveGasPrice
                ? String(args.receipt.effectiveGasPrice)
                : '');
        await this.prisma.mintTransaction.update({
            where: { id: args.mintTransactionId },
            data: {
                txHash: args.txHash,
                status,
                confirmedAt: ok ? new Date() : undefined,
                metadataJson: {
                    gasUsed,
                    effectiveGasPrice: egp,
                    blockNumber: args.receipt.blockNumber?.toString?.() ?? '',
                    transactionStatus: Number(args.receipt.status),
                } as object,
            },
        });
        await this.prisma.mintJob.update({
            where: { id: args.mintJobId },
            data: {
                status,
                txHash: args.txHash,
                confirmedAt: ok ? new Date() : undefined,
                errorCode: ok ? undefined : 'TX_REVERTED',
            },
        });
    }
}
