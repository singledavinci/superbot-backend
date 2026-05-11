export type DropFailureCode =
    | 'FAIL_MISSING_PROOF'
    | 'FAIL_UNKNOWN_PRICE'
    | 'FAIL_UNKNOWN_FUNCTION'
    | 'FAIL_NOT_ELIGIBLE'
    | 'CHAIN_UNSUPPORTED'
    | 'DROP_SOURCE_UNSUPPORTED'
    | 'DEGRADED_PROVIDER_ERROR';

export type DropType = 'public' | 'fcfs' | 'allowlist' | 'gtd' | 'unknown';

export type MintFunction = 'mintPublic' | null;

/** Fully resolved mint context (on-chain + official API only). */
export interface ResolvedDrop {
    chainId: number;
    /** NFT contract (collection). */
    collectionAddress: string;
    /** Same as collectionAddress; explicit for builders. */
    nftContract: string;
    /** SeaDrop (or compatible) contract that receives the mint transaction. */
    seaDropContract: string;
    /** Legacy aggregate field: equals `seaDropContract` for new resolves. */
    mintContract: string;
    source: string;
    dropType: DropType;
    startTime: number | null;
    endTime: number | null;
    /** Wei per unit (native), decimal string. */
    priceNative: string | null;
    maxPerWallet: number | null;
    maxSupply: number | null;
    stageId: string | null;
    requiresProof: boolean;
    requiresSignature: boolean;
    /** 4-byte selector for the chosen mint path, or null if unknown. */
    functionSelector: string | null;
    mintFunction: MintFunction;
    /** Optional OpenSea collection slug from official contract endpoint. */
    openSeaCollectionSlug: string | null;
    /** Suggested fee recipient; zero address allowed when not restricted. */
    feeRecipient: string | null;
    restrictFeeRecipients: boolean;
}

export type DropResolveResult =
    | { ok: true; drop: ResolvedDrop }
    | { ok: false; code: DropFailureCode | string; message: string };
