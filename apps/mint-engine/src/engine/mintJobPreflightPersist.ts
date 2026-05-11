import type { PrismaClient } from '@superbot/database';

export async function mergeMintJobMetadataJson(
    prisma: PrismaClient,
    mintJobId: string,
    patch: Record<string, unknown>,
): Promise<void> {
    const row = await prisma.mintJob.findUnique({
        where: { id: mintJobId },
        select: { metadataJson: true },
    });
    const prev = (row?.metadataJson as Record<string, unknown> | null) ?? {};
    await prisma.mintJob.update({
        where: { id: mintJobId },
        data: { metadataJson: { ...prev, ...patch } as object },
    });
}

/** Abbreviated unsigned prepare payload for MintJob.metadataJson (no signing, no broadcast). */
export function unsignedPrepareMetadata(payload: Record<string, unknown>): Record<string, unknown> {
    const data = payload.data;
    return {
        kind: payload.kind,
        chainId: payload.chainId,
        to: payload.to,
        valueWei: payload.value,
        gasLimit: payload.gasLimit,
        maxFeePerGas: payload.maxFeePerGas,
        maxPriorityFeePerGas: payload.maxPriorityFeePerGas,
        calldataLength: typeof data === 'string' ? data.length : 0,
        calldataPrefix: typeof data === 'string' ? data.slice(0, 18) : null,
        nftContract: payload.nftContract,
        mintFunction: payload.mintFunction,
    };
}

export async function persistMintJobPreflightFields(args: {
    prisma: PrismaClient;
    mintJobId: string;
    planHash: string;
    simulationStatus: string;
    errorCode: string | null;
    executionMode?: string;
    unsignedPrepare?: Record<string, unknown> | null;
    blockReason?: string | null;
}): Promise<void> {
    const row = await args.prisma.mintJob.findUnique({
        where: { id: args.mintJobId },
        select: { metadataJson: true },
    });
    const prev = (row?.metadataJson as Record<string, unknown> | null) ?? {};
    const unsigned = args.unsignedPrepare ? unsignedPrepareMetadata(args.unsignedPrepare) : undefined;
    await args.prisma.mintJob.update({
        where: { id: args.mintJobId },
        data: {
            planHash: args.planHash,
            simulationStatus: args.simulationStatus,
            errorCode: args.errorCode,
            metadataJson: {
                ...prev,
                preflightLast: {
                    at: new Date().toISOString(),
                    planHash: args.planHash,
                    simulationStatus: args.simulationStatus,
                    executionMode: args.executionMode ?? null,
                    unsignedPreparePresent: Boolean(args.unsignedPrepare),
                    unsignedPrepare: unsigned,
                    blockReason: args.blockReason ?? null,
                    signingOccurred: false,
                    broadcastOccurred: false,
                },
            } as object,
        },
    });
}
