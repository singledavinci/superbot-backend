import { Interface, id } from 'ethers';

const ZERO_HASH = '0x' + '00'.repeat(32);

/** True when allowlist merkle root is non-zero (proof required; engine fails closed without proof). */
export function isActiveSeadropAllowlistRoot(root: string): boolean {
    const s = root.toLowerCase();
    return s.length === 66 && s !== ZERO_HASH;
}

/** Minimal ERC721SeaDrop-style NFT surface. */
export const NFT_SEA_DROP_IFACE = new Interface([
    'function seaDrop() view returns (address)',
]);

/** OpenSea SeaDrop core (subset; matches widely deployed SeaDrop clones). */
export const SEA_DROP_IFACE = new Interface([
    'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
    'function getAllowListMerkleRoot(address nftContract) view returns (bytes32)',
    'function getSigners(address nftContract) view returns (address[])',
    'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
    'function getFeeRecipientIsAllowed(address nftContract, address feeRecipient) view returns (bool)',
    'function getCreatorPayoutAddress(address nftContract) view returns (address)',
    'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
]);

export type PublicDropTuple = {
    mintPrice: bigint;
    startTime: bigint;
    endTime: bigint;
    maxTotalMintableByWallet: bigint;
    feeBps: bigint;
    restrictFeeRecipients: boolean;
};

function asBig(v: unknown): bigint | null {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === 'string' && v.trim()) {
        try {
            return BigInt(v);
        } catch {
            return null;
        }
    }
    return null;
}

export function decodePublicDrop(raw: unknown): PublicDropTuple | null {
    if (raw == null) return null;
    if (Array.isArray(raw) && raw.length >= 6) {
        const mp = asBig(raw[0]);
        const st = asBig(raw[1]);
        const et = asBig(raw[2]);
        const mx = asBig(raw[3]);
        const fb = asBig(raw[4]);
        const rr = raw[5];
        if (mp === null || st === null || et === null || mx === null || fb === null) return null;
        if (typeof rr !== 'boolean') return null;
        return { mintPrice: mp, startTime: st, endTime: et, maxTotalMintableByWallet: mx, feeBps: fb, restrictFeeRecipients: rr };
    }
    if (typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const mp = asBig(r.mintPrice);
    const st = asBig(r.startTime);
    const et = asBig(r.endTime);
    const mx = asBig(r.maxTotalMintableByWallet);
    const fb = asBig(r.feeBps);
    const rr = r.restrictFeeRecipients;
    if (mp === null || st === null || et === null || mx === null || fb === null) return null;
    if (typeof rr !== 'boolean') return null;
    return {
        mintPrice: mp,
        startTime: st,
        endTime: et,
        maxTotalMintableByWallet: mx,
        feeBps: fb,
        restrictFeeRecipients: rr,
    };
}

/** Cached at module load — no runtime ABI fetch. */
const _mintPub = SEA_DROP_IFACE.getFunction('mintPublic');
export const MINT_PUBLIC_SELECTOR = _mintPub
    ? _mintPub.selector
    : id('mintPublic(address,address,address,uint256)').slice(0, 10);
