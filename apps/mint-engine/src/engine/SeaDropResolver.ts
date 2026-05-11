import axios from 'axios';
import { Contract, JsonRpcProvider, ZeroAddress } from 'ethers';
import { mintEnv } from '../config/mintEnv';
import type { DropResolveResult, ResolvedDrop, DropType } from './mintTypes';
import { decodePublicDrop, isActiveSeadropAllowlistRoot, MINT_PUBLIC_SELECTOR, NFT_SEA_DROP_IFACE, SEA_DROP_IFACE } from './seaDropAbi';

const CHAIN_SLUG: Record<number, string> = {
    1: 'ethereum',
    11155111: 'sepolia',
    5: 'goerli',
};

/** OpenSea SeaDrop minter at cross-chain CREATE2 address (mainnet + Sepolia, and other deployed networks). */
const DEFAULT_CANONICAL_SEA_DROP = '0x00005ea00ac477b1030ce78506496e8c2de24bf5';

function parseOptionalAddress(raw: string): string | null {
    const s = raw.trim().toLowerCase();
    if (!s || !/^0x[a-f0-9]{40}$/.test(s)) return null;
    return s;
}

/** Default CREATE2 minter on chains where OpenSea publishes this address; else only env override. */
function canonicalSeaDropForChain(chainId: number): string | null {
    const fromEnv = parseOptionalAddress(mintEnv.MINT_SEADROP_CANONICAL);
    if (fromEnv) return fromEnv;
    if (chainId === 1 || chainId === 11155111) return DEFAULT_CANONICAL_SEA_DROP;
    return null;
}

const ZERO_HASH = '0x' + '00'.repeat(32);

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

function isUnsetPublicDrop(pd: { mintPrice: bigint; startTime: bigint; endTime: bigint; maxTotalMintableByWallet: bigint }): boolean {
    return pd.mintPrice === 0n && pd.startTime === 0n && pd.endTime === 0n && pd.maxTotalMintableByWallet === 0n;
}

/**
 * Resolves SeaDrop / OpenSea mint stages using:
 * - OpenSea **official** HTTP API (contract metadata only), and
 * - On-chain `seaDrop()` when present, else **default OpenSea CREATE2 SeaDrop** (mainnet + Sepolia) or **`MINT_SEADROP_CANONICAL`** when `getPublicDrop(nft)` is configured there, plus `getAllowListMerkleRoot` reads via HTTPS RPC.
 *
 * Fails closed on unknown price/function, allowlist requirements, or missing RPC/API.
 */
export class SeaDropResolver {
    async resolve(args: {
        chainId: number;
        nftContract: string;
        rpcUrl: string | null;
    }): Promise<DropResolveResult> {
        const chainSlug = CHAIN_SLUG[args.chainId];
        if (!chainSlug) {
            return { ok: false, code: 'CHAIN_UNSUPPORTED', message: String(args.chainId) };
        }
        if (!args.rpcUrl) {
            return {
                ok: false,
                code: 'DEGRADED_PROVIDER_ERROR',
                message: 'HTTPS RPC required for on-chain SeaDrop verification (set MINT_ENGINE_RPC_URL or HTTPS_RPC_URL)',
            };
        }
        if (!mintEnv.OPENSEA_API_KEY) {
            return {
                ok: false,
                code: 'DEGRADED_PROVIDER_ERROR',
                message: 'OPENSEA_API_KEY required for official OpenSea contract validation',
            };
        }

        const nft = args.nftContract.toLowerCase();
        let openSeaSlug: string | null = null;
        try {
            const url = `https://api.opensea.io/api/v2/chain/${chainSlug}/contract/${nft}`;
            const res = await axios.get<{ collection?: string }>(url, {
                headers: { 'x-api-key': mintEnv.OPENSEA_API_KEY },
                timeout: 10_000,
            });
            openSeaSlug = typeof res.data.collection === 'string' ? res.data.collection : null;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, code: 'DEGRADED_PROVIDER_ERROR', message: msg };
        }

        const provider = new JsonRpcProvider(args.rpcUrl);
        const nftC = new Contract(nft, NFT_SEA_DROP_IFACE, provider);
        let seaDropAddr: string | null = null;
        try {
            const fromNft = (await nftC.seaDrop.staticCall()) as string;
            if (fromNft && fromNft.toLowerCase() !== ZeroAddress.toLowerCase()) {
                seaDropAddr = fromNft;
            }
        } catch {
            /* ERC721SeaDrop clones often omit seaDrop(); try canonical minter below. */
        }

        const canon = canonicalSeaDropForChain(args.chainId);
        if (!seaDropAddr && canon) {
            const sdCanon = new Contract(canon, SEA_DROP_IFACE, provider);
            try {
                const raw = await sdCanon.getPublicDrop.staticCall(nft);
                const pdProbe = decodePublicDrop(raw);
                if (pdProbe && !isUnsetPublicDrop(pdProbe)) {
                    seaDropAddr = canon;
                }
            } catch {
                /* no configured public drop on canonical SeaDrop */
            }
        }

        if (!seaDropAddr) {
            const triedCanonResolver = canon !== null;
            return {
                ok: false,
                code: 'FAIL_UNKNOWN_FUNCTION',
                message: triedCanonResolver
                    ? 'NFT has no seaDrop() and canonical SeaDrop has no configured public drop for this contract'
                    : 'NFT does not expose seaDrop(); set MINT_SEADROP_CANONICAL to the chain minter or use a token that implements seaDrop()',
            };
        }

        const sd = new Contract(seaDropAddr, SEA_DROP_IFACE, provider);

        let allowRoot: string = ZERO_HASH;
        try {
            allowRoot = (await sd.getAllowListMerkleRoot.staticCall(nft)) as string;
        } catch {
            allowRoot = ZERO_HASH;
        }
        if (isActiveSeadropAllowlistRoot(allowRoot)) {
            return {
                ok: false,
                code: 'FAIL_MISSING_PROOF',
                message: 'Allowlist merkle root is active; merkle proof must be supplied and verified off-engine',
            };
        }

        /* getSigners may be set for optional signed-mint paths; mintPublic does not use it. */

        let publicDropRaw: unknown;
        try {
            publicDropRaw = await sd.getPublicDrop.staticCall(nft);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                ok: false,
                code: 'FAIL_UNKNOWN_FUNCTION',
                message: `getPublicDrop failed: ${msg}`,
            };
        }

        const pd = decodePublicDrop(publicDropRaw);
        if (!pd) {
            return { ok: false, code: 'FAIL_UNKNOWN_PRICE', message: 'Could not decode getPublicDrop tuple' };
        }

        if (isUnsetPublicDrop(pd)) {
            return { ok: false, code: 'FAIL_UNKNOWN_PRICE', message: 'Public drop fields are unset on-chain' };
        }

        const priceWei = pd.mintPrice;
        const priceStr = priceWei >= 0n ? priceWei.toString(10) : null;
        if (priceStr === null) {
            return { ok: false, code: 'FAIL_UNKNOWN_PRICE', message: 'Invalid mintPrice from chain' };
        }

        const startSec = Number(pd.startTime);
        const endSec = Number(pd.endTime);
        const maxW = Number(pd.maxTotalMintableByWallet);
        if (!Number.isFinite(maxW) || maxW <= 0 || maxW > 1_000_000) {
            return { ok: false, code: 'FAIL_UNKNOWN_PRICE', message: 'Invalid maxTotalMintableByWallet from chain' };
        }

        const t = nowSec();
        let dropType: DropType = 'public';
        if (Number.isFinite(startSec) && startSec > t) {
            dropType = 'fcfs';
        }

        const seaLc = seaDropAddr.toLowerCase();
        const drop: ResolvedDrop = {
            chainId: args.chainId,
            collectionAddress: nft,
            nftContract: nft,
            seaDropContract: seaLc,
            mintContract: seaLc,
            source: 'seadrop',
            dropType,
            startTime: Number.isFinite(startSec) && startSec > 0 ? startSec * 1000 : null,
            endTime: Number.isFinite(endSec) && endSec > 0 ? endSec * 1000 : null,
            priceNative: priceStr,
            maxPerWallet: maxW,
            maxSupply: null,
            stageId: 'public',
            requiresProof: false,
            requiresSignature: false,
            functionSelector: MINT_PUBLIC_SELECTOR,
            mintFunction: 'mintPublic',
            openSeaCollectionSlug: openSeaSlug,
            feeRecipient: process.env.MINT_SEADROP_FEE_RECIPIENT?.trim() || ZeroAddress,
            restrictFeeRecipients: pd.restrictFeeRecipients,
        };

        if (drop.restrictFeeRecipients && drop.feeRecipient === ZeroAddress) {
            return {
                ok: false,
                code: 'FAIL_NOT_ELIGIBLE',
                message: 'restrictFeeRecipients=true requires MINT_SEADROP_FEE_RECIPIENT to be set to an allowed recipient',
            };
        }

        return { ok: true, drop };
    }
}
