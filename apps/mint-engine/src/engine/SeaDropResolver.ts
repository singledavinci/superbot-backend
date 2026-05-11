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

const ZERO_HASH = '0x' + '00'.repeat(32);

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

/**
 * Resolves SeaDrop / OpenSea mint stages using:
 * - OpenSea **official** HTTP API (contract metadata only), and
 * - On-chain `seaDrop()` + `getPublicDrop` / `getAllowListMerkleRoot` reads via HTTPS RPC.
 *
 * Fails closed on unknown price/function, allowlist/signature requirements, or missing RPC/API.
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
        let seaDropAddr: string;
        try {
            seaDropAddr = (await nftC.seaDrop.staticCall()) as string;
        } catch {
            return {
                ok: false,
                code: 'FAIL_UNKNOWN_FUNCTION',
                message: 'NFT does not expose seaDrop(); not a supported SeaDrop-style collection',
            };
        }
        if (!seaDropAddr || seaDropAddr.toLowerCase() === ZeroAddress.toLowerCase()) {
            return { ok: false, code: 'FAIL_UNKNOWN_FUNCTION', message: 'seaDrop() returned zero address' };
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

        try {
            const signers = (await sd.getSigners.staticCall(nft)) as string[];
            if (
                Array.isArray(signers) &&
                signers.some(s => typeof s === 'string' && s.toLowerCase() !== ZeroAddress.toLowerCase())
            ) {
                return {
                    ok: false,
                    code: 'FAIL_MISSING_PROOF',
                    message: 'Server-signed mint path is configured; not supported in prepare-only beta',
                };
            }
        } catch {
            /* getSigners optional on older deployments */
        }

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

        if (pd.mintPrice === 0n && pd.startTime === 0n && pd.endTime === 0n && pd.maxTotalMintableByWallet === 0n) {
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
