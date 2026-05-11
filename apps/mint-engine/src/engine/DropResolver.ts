import type { PrismaClient } from '@superbot/database';
import { mintEnv } from '../config/mintEnv';
import { SeaDropResolver } from './SeaDropResolver';
import type { DropResolveResult, ResolvedDrop } from './mintTypes';
import type IORedis from 'ioredis';

export type { DropResolveResult, ResolvedDrop } from './mintTypes';

const CACHE_PREFIX = 'mint:drop:v1:';

export class DropResolver {
    private sea = new SeaDropResolver();

    constructor(
        private prisma: PrismaClient,
        private redis: IORedis | null,
    ) {}

    async resolve(args: {
        chainId: number;
        collectionAddress: string;
        mintContract?: string;
        dropSource: string;
        rpcUrl: string | null;
    }): Promise<DropResolveResult> {
        const nft = (args.mintContract || args.collectionAddress).toLowerCase();
        const cacheKey = `${CACHE_PREFIX}${args.chainId}:${nft}`;

        if (this.redis) {
            try {
                const hit = await this.redis.get(cacheKey);
                if (hit) {
                    const parsed = JSON.parse(hit) as ResolvedDrop;
                    if (parsed.mintFunction === 'mintPublic' && parsed.functionSelector && parsed.priceNative) {
                        return { ok: true, drop: parsed };
                    }
                }
            } catch {
                /* ignore cache */
            }
        }

        const row = await this.prisma.mintDrop.findFirst({
            where: { chainId: args.chainId, mintContract: nft },
            orderBy: { updatedAt: 'desc' },
        });
        const meta = row?.metadataJson as { resolverVersion?: number; mintFunction?: string } | null;
        if (
            row &&
            row.status === 'resolved' &&
            row.priceNative &&
            meta?.resolverVersion === 1 &&
            meta.mintFunction === 'mintPublic'
        ) {
            return {
                ok: true,
                drop: {
                    chainId: row.chainId,
                    collectionAddress: row.collectionAddress.toLowerCase(),
                    nftContract: row.collectionAddress.toLowerCase(),
                    seaDropContract: row.mintContract.toLowerCase(),
                    mintContract: row.mintContract.toLowerCase(),
                    source: row.source,
                    dropType: (row.dropType as ResolvedDrop['dropType']) || 'public',
                    startTime: row.startTime?.getTime() ?? null,
                    endTime: row.endTime?.getTime() ?? null,
                    priceNative: row.priceNative,
                    maxPerWallet: row.maxPerWallet,
                    maxSupply: row.maxSupply,
                    stageId: row.stageId,
                    requiresProof: row.requiresProof,
                    requiresSignature: row.requiresSignature,
                    functionSelector: (meta as { functionSelector?: string }).functionSelector ?? null,
                    mintFunction: 'mintPublic',
                    openSeaCollectionSlug: (meta as { openSeaCollectionSlug?: string | null }).openSeaCollectionSlug ?? null,
                    feeRecipient: (meta as { feeRecipient?: string | null }).feeRecipient ?? null,
                    restrictFeeRecipients: Boolean((meta as { restrictFeeRecipients?: boolean }).restrictFeeRecipients),
                },
            };
        }

        if ((args.dropSource === 'opensea' || args.dropSource === 'seadrop') && mintEnv.MINT_OPENSEA_SEADROP_ENABLED) {
            const r = await this.sea.resolve({
                chainId: args.chainId,
                nftContract: nft,
                rpcUrl: args.rpcUrl,
            });
            if (r.ok && this.redis) {
                try {
                    await this.redis.set(cacheKey, JSON.stringify(r.drop), 'EX', 120);
                } catch {
                    /* ignore */
                }
            }
            if (r.ok) {
                await this.persistDropRow(r.drop);
            }
            return r;
        }

        return { ok: false, code: 'DROP_SOURCE_UNSUPPORTED', message: `dropSource=${args.dropSource}` };
    }

    private async persistDropRow(drop: ResolvedDrop): Promise<void> {
        await this.prisma.mintDrop.create({
            data: {
                chainId: drop.chainId,
                collectionAddress: drop.collectionAddress,
                mintContract: drop.seaDropContract,
                source: drop.source,
                dropType: drop.dropType,
                startTime: drop.startTime ? new Date(drop.startTime) : null,
                endTime: drop.endTime ? new Date(drop.endTime) : null,
                priceNative: drop.priceNative,
                maxPerWallet: drop.maxPerWallet,
                maxSupply: drop.maxSupply,
                stageId: drop.stageId,
                requiresProof: drop.requiresProof,
                requiresSignature: drop.requiresSignature,
                status: 'resolved',
                resolvedAt: new Date(),
                metadataJson: {
                    resolverVersion: 1,
                    mintFunction: drop.mintFunction,
                    functionSelector: drop.functionSelector,
                    openSeaCollectionSlug: drop.openSeaCollectionSlug,
                    feeRecipient: drop.feeRecipient,
                    restrictFeeRecipients: drop.restrictFeeRecipients,
                    nftContract: drop.nftContract,
                },
            },
        });
    }
}
