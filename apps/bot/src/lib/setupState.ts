import { redisConnection } from '@superbot/queue';

const TTL_SEC = 900;

export type CollectionSetupDraft = {
    contract: string;
    name: string;
    floorDropPct: number | null;
    floorRisePct: number | null;
    hotMintEnabled: boolean;
    delistEnabled: boolean;
    imageUrl?: string | null;
};

export type WalletSetupDraft = {
    address: string;
    label: string | null;
};

function collKey(guildId: string, userId: string): string {
    return `wiz:coll:${guildId}:${userId}`;
}

function walletKey(guildId: string, userId: string): string {
    return `wiz:wallet:${guildId}:${userId}`;
}

export async function getCollectionDraft(
    guildId: string,
    userId: string,
): Promise<CollectionSetupDraft | null> {
    const raw = await redisConnection.get(collKey(guildId, userId));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as CollectionSetupDraft;
    } catch {
        return null;
    }
}

export async function setCollectionDraft(
    guildId: string,
    userId: string,
    draft: CollectionSetupDraft,
): Promise<void> {
    await redisConnection.set(collKey(guildId, userId), JSON.stringify(draft), 'EX', TTL_SEC);
}

export async function clearCollectionDraft(guildId: string, userId: string): Promise<void> {
    await redisConnection.del(collKey(guildId, userId));
}

export async function getWalletDraft(guildId: string, userId: string): Promise<WalletSetupDraft | null> {
    const raw = await redisConnection.get(walletKey(guildId, userId));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as WalletSetupDraft;
    } catch {
        return null;
    }
}

export async function setWalletDraft(
    guildId: string,
    userId: string,
    draft: WalletSetupDraft,
): Promise<void> {
    await redisConnection.set(walletKey(guildId, userId), JSON.stringify(draft), 'EX', TTL_SEC);
}

export async function clearWalletDraft(guildId: string, userId: string): Promise<void> {
    await redisConnection.del(walletKey(guildId, userId));
}
