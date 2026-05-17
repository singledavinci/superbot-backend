import { EmbedBuilder, type ColorResolvable } from 'discord.js';
import type { IntelligenceReport, ContextualExplanation } from '@superbot/types';
import {
    formatFallbackCollectionName,
    type NFTMetadata,
    type CollectionMetadata,
    type WalletProfile,
} from '@superbot/analytics';
import { links } from './links';
import {
    EMBED_COLORS,
    STANDARD_MARKET_DISCLAIMER,
    alertCategoryLine,
    superbotFooter,
} from './lib/embedTheme';

export { STANDARD_MARKET_DISCLAIMER };

function capitalizeConfidence(c: ContextualExplanation['confidence']): string {
    return c.slice(0, 1).toUpperCase() + c.slice(1);
}

/** Adds the structured “Why it matters” block inside Discord field limits (≤1024 chars). */
export function appendWhyItMattersEmbed(
    embed: EmbedBuilder,
    cx: ContextualExplanation,
    aiNarrative?: string | null,
) {
    const ev = cx.evidence.slice(0, 4);
    const chunks: string[] = [
        `**Event:** ${cx.event}`,
        `**Signal:** ${cx.signal}`,
        '**Evidence:**',
        ...ev.map(e => `• ${e}`),
        `**Risk:** ${cx.risk}`,
        `**Next watch:** ${cx.nextWatch}`,
        `**Confidence:** ${capitalizeConfidence(cx.confidence)}`,
    ];
    if (cx.dataLimitations.length > 0) {
        chunks.push(`**Data limitations:** ${cx.dataLimitations.slice(0, 3).join('; ')}`);
    }
    if (aiNarrative?.trim()) {
        chunks.push(`**Plain recap:** ${aiNarrative.trim().slice(0, 380)}`);
    }
    let body = chunks.join('\n').trim();
    if (body.length > 1000) body = `${body.slice(0, 990)}…`;
    embed.addFields({ name: 'Why it matters', value: body, inline: false });
}

/** Truncate a 0x-prefixed hex address for display: 0x1234…abcd. */
function shortAddr(addr: string | null | undefined, prefix = 6, suffix = 4): string {
    if (!addr) return '—';
    if (addr.length <= prefix + suffix) return addr;
    return `${addr.slice(0, prefix)}…${addr.slice(-suffix)}`;
}

/** Returns ENS name when present, otherwise a shortened address. */
function walletDisplay(profile?: WalletProfile | null, fallbackAddr?: string): string {
    if (profile?.ens) return profile.ens;
    return shortAddr(profile?.address ?? fallbackAddr ?? '');
}

/**
 * Discord rejects non-https image URLs and ignores ipfs:// directly. Convert
 * to a public gateway, otherwise drop the field so the embed renders cleanly.
 */
function normalizeImageUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('ipfs://')) {
        return `https://ipfs.io/ipfs/${trimmed.slice('ipfs://'.length)}`;
    }
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
        return trimmed;
    }
    return null;
}

/** Best display title: "<Collection> <#tokenId>" with sensible fallbacks — never raw `0x…` alone. */
function nftTitle(
    nftMeta: NFTMetadata | null | undefined,
    collectionName: string,
    contract: string,
    tokenId: string | undefined,
): string {
    const lc =
        collectionName?.trim()?.length > 0
            ? collectionName.trim()
            : formatFallbackCollectionName(contractForLookup(nftMeta, contract));

    if (nftMeta?.name) {
        // OpenSea names usually already include a #N suffix; trust them.
        return nftMeta.name;
    }
    if (tokenId) return `${lc} #${tokenId}`;
    return lc;
}

function contractForLookup(nftMeta: NFTMetadata | null | undefined, contract: string): string {
    return (nftMeta?.contract || contract || '').trim();
}

/** Human-readable span between two ms epochs (Discord copy). */
function humanizeWindowMs(ms: number): string {
    if (!(ms >= 0) || Number.isNaN(ms)) return '—';
    if (ms < 1000) return '<1s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${m} minute${m === 1 ? '' : 's'}` : `${m}m ${r}s`;
}

export function createWalletActionBatchEmbed(data: {
    contract: string;
    chain: string;
    collectionName: string;
    wallet: string;
    batchBehavior: 'buy' | 'sale' | 'mint';
    intelligence?: IntelligenceReport;
    walletProfile?: WalletProfile | null;
    nftMeta?: NFTMetadata | null;
    label?: string | null;
    batch: {
        itemCount: number;
        totalNative: number;
        currency: string;
        txHashes: string[];
        blockRange: { first: number; last: number };
        firstSeenAt: number;
        lastSeenAt: number;
        sampleTokenIds: string[];
        sampleNftNames: string[];
        marketplace?: string;
        possibleWashTrading?: boolean;
    };
}) {
    const who = walletDisplay(data.walletProfile, data.wallet);
    const coll = data.collectionName || shortAddr(data.contract);
    let titleLead = '🚨 Batch Buy';
    let color: ColorResolvable = getGradeColor(data.intelligence?.grade);
    if (data.batchBehavior === 'sale') {
        titleLead = '🔻 Batch Sale';
        color = 0xff4444;
    } else if (data.batchBehavior === 'mint') {
        titleLead = '🎨 Batch Mint';
        color = 0x00ffee;
    }
    const title = `${titleLead} — ${who} ${data.batchBehavior === 'sale' ? 'sold' : data.batchBehavior === 'mint' ? 'minted' : 'bought'} ${data.batch.itemCount} × ${coll}`;

    const txCount = data.batch.txHashes.length;
    const windowMs = Math.max(0, data.batch.lastSeenAt - data.batch.firstSeenAt);
    let descPieces: string[] = [
        `Across **${txCount}** tx(s) over **${humanizeWindowMs(windowMs)}**.`,
    ];
    const showSpend =
        (data.batchBehavior === 'buy' || data.batchBehavior === 'sale') &&
        data.batch.totalNative > 0;
    if (showSpend) {
        descPieces.push(`Total **${data.batch.totalNative.toFixed(4)} ${data.batch.currency || 'ETH'}**.`);
    }
    if (data.batchBehavior === 'mint' && data.batch.totalNative <= 0) {
        descPieces = [`Across **${txCount}** tx(s) over **${humanizeWindowMs(windowMs)}**.`];
    }

    const embed = new EmbedBuilder().setColor(color).setTitle(title);

    const thumb =
        normalizeImageUrl(data.nftMeta?.thumbnailUrl ?? data.nftMeta?.imageUrl) ?? null;
    if (thumb) embed.setThumbnail(thumb);

    if (data.walletProfile) {
        const author = walletDisplay(data.walletProfile, data.wallet);
        embed.setAuthor({
            name: data.label ? `${data.label} · ${author}` : author,
            url: data.walletProfile.openseaUrl,
        });
    } else if (data.label) {
        embed.setAuthor({ name: data.label });
    }

    embed.setDescription(
        `**Signal:** \`${data.intelligence?.grade || 'Neutral'}\` · ` + descPieces.join(' '),
    );

    embed.addFields(
        { name: 'Item count', value: String(data.batch.itemCount), inline: true },
        {
            name: 'Wallet',
            value: data.walletProfile?.openseaUrl
                ? `[${walletDisplay(data.walletProfile, data.wallet)}](${data.walletProfile.openseaUrl})`
                : `\`${shortAddr(data.wallet)}\``,
            inline: true,
        },
    );

    if (showSpend) {
        embed.addFields({
            name: data.batchBehavior === 'sale' ? 'Total volume' : 'Total spend',
            value: `${data.batch.totalNative.toFixed(4)} ${data.batch.currency || 'ETH'}`,
            inline: true,
        });
    }

    const { first, last } = data.batch.blockRange;
    if (first > 0 && last > 0) {
        embed.addFields({
            name: 'Block range',
            value: first === last ? `${first}` : `${first} → ${last}`,
            inline: true,
        });
    }

    if (data.batch.marketplace) {
        embed.addFields({ name: 'Marketplace', value: data.batch.marketplace, inline: true });
    }

    const sampleLines: string[] = [];
    const n = Math.min(5, data.batch.sampleTokenIds.length);
    for (let i = 0; i < n; i++) {
        const tid = data.batch.sampleTokenIds[i];
        const nm = data.batch.sampleNftNames[i];
        const label = nm && nm.trim() ? nm : `#${tid}`;
        sampleLines.push(`• [${label}](${links.opensea.nft(data.contract, tid)})`);
    }
    if (sampleLines.length > 0) {
        embed.addFields({ name: 'Sample token IDs', value: sampleLines.join('\n').slice(0, 1024), inline: false });
    }

    if (data.walletProfile?.holdingsCount !== null && data.walletProfile?.holdingsCount !== undefined) {
        embed.addFields({
            name: 'Wallet holdings',
            value: `${data.walletProfile.holdingsCount} NFTs`,
            inline: true,
        });
    }

    if (data.walletProfile?.topCollectionsByCount && data.walletProfile.topCollectionsByCount.length > 0) {
        embed.addFields({
            name: 'Wallet portfolio (top 3)',
            value: data.walletProfile.topCollectionsByCount
                .map(c => `• ${c.name} ×${c.count}`)
                .join('\n'),
            inline: false,
        });
    }

    embed.addFields({
        name: '🧠 AI Context Engine',
        value: `*${data.intelligence?.context || 'No context available.'}*`,
    });

    if (data.intelligence?.risk) {
        embed.addFields({ name: '⚠️ Risk', value: `*${data.intelligence.risk}*` });
    }

    if (data.batch.possibleWashTrading) {
        embed.addFields({
            name: '⚠ Possible wash',
            value:
                '*At least one leg showed buyer/seller NFT movement in the last 30 days (best-effort graph). Not a verdict — verify on-chain.*',
        });
    }

    const linkParts: string[] = [];
    const firstTx = data.batch.txHashes.find(h => /^0x[a-fA-F0-9]{64}$/.test(h));
    if (firstTx) linkParts.push(`[First tx](${links.etherscan.tx(firstTx)})`);
    linkParts.push(markdownCollectionToolkit(data.contract, data.nftMeta?.collectionSlug ?? null));
    if (linkParts.length) embed.addFields({ name: 'Links', value: linkParts.join(' · '), inline: false });

    return embed.setTimestamp().setFooter({ text: superbotFooter('Wallet batches') });
}

export function createWhaleBuyEmbed(data: {
    contract: string;
    /** Human-readable collection label built upstream (resolver); never omit. */
    collectionName: string;
    /** Resolver NFT display title (optional for legacy queue payloads). */
    nftName?: string;
    wallet: string;
    tokenId: string;
    txHash: string;
    alertType: string;
    price?: string;
    currency?: string;
    marketplace?: string;
    label?: string | null;
    intelligence?: IntelligenceReport;
    /** On-chain NFT transfer graph hint only — informational, never suppresses the alert. */
    possibleWashTrading?: boolean;
    nftMeta?: NFTMetadata | null;
    walletProfile?: WalletProfile | null;
    counterpartyProfile?: WalletProfile | null;
}) {
    let titlePrefix = '🚨 Whale Entry';
    let color = getGradeColor(data.intelligence?.grade);

    if (data.alertType === 'WHALE_SALE') {
        titlePrefix = '📉 Whale Sale';
        color = '#ff4444';
    } else if (data.alertType === 'WHALE_MINT') {
        titlePrefix = '🚀 Whale Mint';
        color = '#00ffee';
    }

    const cn =
        data.collectionName?.trim() ? data.collectionName.trim() : formatFallbackCollectionName(data.contract);
    const nftLabel = data.nftName?.trim()
        ? data.nftName.trim()
        : nftTitle(data.nftMeta, cn, data.contract, data.tokenId);
    const title = `${titlePrefix} — ${nftLabel}`;
    const collectionLabel = cn;

    const embed = new EmbedBuilder().setColor(color).setTitle(title);

    const thumb = normalizeImageUrl(data.nftMeta?.thumbnailUrl ?? data.nftMeta?.imageUrl);
    if (thumb) embed.setThumbnail(thumb);

    if (data.walletProfile) {
        const author = walletDisplay(data.walletProfile, data.wallet);
        const url = data.walletProfile.openseaUrl;
        embed.setAuthor({ name: data.label ? `${data.label} · ${author}` : author, url });
    } else if (data.label) {
        embed.setAuthor({ name: data.label });
    }

    embed.setDescription(
        `**Signal:** \`${data.intelligence?.grade || 'Neutral'}\` · ` +
            `**Collection:** ${collectionLabel}`,
    );

    embed.addFields(
        { name: 'Token', value: nftLabel.length > 220 ? `${nftLabel.slice(0, 217)}…` : nftLabel, inline: true },
        {
            name: 'Wallet',
            value: data.walletProfile?.openseaUrl
                ? `[${walletDisplay(data.walletProfile, data.wallet)}](${data.walletProfile.openseaUrl})`
                : `\`${shortAddr(data.wallet)}\``,
            inline: true,
        },
    );

    if (data.price && data.price !== '0') {
        embed.addFields(
            { name: 'Price', value: `${data.price} ${data.currency || 'ETH'}`, inline: true },
            { name: 'Market', value: data.marketplace || 'Unknown', inline: true },
        );
    }

    if (data.nftMeta?.rarityRank) {
        embed.addFields({
            name: 'Rarity Rank',
            value: `#${data.nftMeta.rarityRank}`,
            inline: true,
        });
    }

    if (data.walletProfile?.holdingsCount !== null && data.walletProfile?.holdingsCount !== undefined) {
        embed.addFields({
            name: 'Wallet holdings',
            value: `${data.walletProfile.holdingsCount} NFTs`,
            inline: true,
        });
    }

    if (data.nftMeta?.traits && data.nftMeta.traits.length > 0) {
        const top = data.nftMeta.traits.slice(0, 3);
        embed.addFields({
            name: 'Top traits',
            value: top.map(t => `• **${t.trait_type}:** ${t.value}`).join('\n'),
            inline: false,
        });
    }

    if (data.walletProfile?.topCollectionsByCount && data.walletProfile.topCollectionsByCount.length > 0) {
        embed.addFields({
            name: 'Wallet portfolio (top 3)',
            value: data.walletProfile.topCollectionsByCount
                .map(c => `• ${c.name} ×${c.count}`)
                .join('\n'),
            inline: false,
        });
    }

    if (data.counterpartyProfile) {
        const cp = walletDisplay(data.counterpartyProfile);
        embed.addFields({
            name: data.alertType === 'WHALE_SALE' ? 'Buyer' : 'Seller',
            value: data.counterpartyProfile.openseaUrl
                ? `[${cp}](${data.counterpartyProfile.openseaUrl})`
                : `\`${cp}\``,
            inline: true,
        });
    }

    if (data.intelligence?.contextual) {
        appendWhyItMattersEmbed(embed, data.intelligence.contextual, data.intelligence.aiNarrative);
    } else {
        embed.addFields({
            name: '🧠 Context',
            value: `*${data.intelligence?.context || 'No context available.'}*`,
        });
        if (data.intelligence?.risk) {
            embed.addFields({ name: '⚠️ Risk', value: `*${data.intelligence.risk}*` });
        }
    }

    if (data.possibleWashTrading) {
        embed.addFields({
            name: '⚠ Possible wash',
            value:
                '*Buyer and seller had an NFT transfer between them in the last 30 days (best-effort graph). Not a verdict — verify on-chain.*',
        });
    }

    const linkLine = buildExternalLinks({
        contract: data.contract,
        tokenId: data.tokenId,
        txHash: data.txHash,
        nftOpenseaUrl: data.nftMeta?.openseaUrl ?? null,
    });
    if (linkLine) embed.addFields({ name: 'Links', value: linkLine, inline: false });

    embed.setTimestamp().setFooter({ text: superbotFooter('Whale trades') });

    return embed;
}

export function createClusterBuyEmbed(data: {
    collectionName: string;
    contract: string;
    chain: string;
    wallets: string[];
    windowMinutes: number;
    triggerTxHash: string;
    triggerBuyer: string;
    nftName?: string;
    triggerTokenId?: string;
    collectionMeta?: CollectionMetadata | null;
    triggerProfile?: WalletProfile | null;
    contextualExplanation?: ContextualExplanation | null;
    aiNarrative?: string | null;
}) {
    const sample = data.wallets.slice(0, 12).join(', ') + (data.wallets.length > 12 ? '…' : '');
    const collectionLabel = data.collectionName?.trim()
        ? data.collectionName.trim()
        : formatFallbackCollectionName(data.contract);

    const headline = data.nftName?.trim() ? data.nftName.trim() : collectionLabel;
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.cluster)
        .setTitle(`🧲 Cluster buy — ${headline}`)
        .setDescription(
            alertCategoryLine('Smart-money cluster', `${data.wallets.length} wallets · ~${data.windowMinutes} min`) +
                `\n\nMultiple tracked wallets bought **${collectionLabel}** in a short window.`,
        );

    const thumb = normalizeImageUrl(data.collectionMeta?.imageUrl);
    if (thumb) embed.setThumbnail(thumb);

    if (data.triggerProfile) {
        embed.setAuthor({
            name: `Trigger buyer: ${walletDisplay(data.triggerProfile, data.triggerBuyer)}`,
            url: data.triggerProfile.openseaUrl,
        });
    }

    embed.addFields(
        { name: 'Collection', value: collectionLabel, inline: true },
        { name: 'Chain', value: data.chain, inline: true },
        { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: true },
        { name: 'Wallets (sample)', value: sample.slice(0, 900) || '—', inline: false },
        {
            name: 'Latest buy (tx)',
            value: /^0x[a-fA-F0-9]{64}$/.test(data.triggerTxHash)
                ? `[Tx](${links.etherscan.tx(data.triggerTxHash)})`
                : 'Not available',
            inline: true,
        },
        {
            name: 'Trigger buyer',
            value: data.triggerProfile?.openseaUrl
                ? `[${walletDisplay(data.triggerProfile, data.triggerBuyer)}](${data.triggerProfile.openseaUrl})`
                : `\`${shortAddr(data.triggerBuyer)}\``,
            inline: true,
        },
    );

    if (data.nftName?.trim() && data.triggerTokenId?.trim()) {
        const tid = data.triggerTokenId.trim();
        const itemUrl = `https://opensea.io/assets/ethereum/${data.contract.toLowerCase()}/${tid}`;
        embed.addFields({
            name: 'Trigger NFT',
            value: `[${data.nftName.trim()}](${itemUrl})`,
            inline: false,
        });
    }

    if (data.triggerProfile?.holdingsCount !== null && data.triggerProfile?.holdingsCount !== undefined) {
        embed.addFields({
            name: 'Trigger wallet holdings',
            value: `${data.triggerProfile.holdingsCount} NFTs`,
            inline: true,
        });
    }

    if (data.contextualExplanation) {
        appendWhyItMattersEmbed(embed, data.contextualExplanation, data.aiNarrative);
    }

    embed.addFields({
        name: 'Links',
        value: markdownCollectionToolkit(data.contract, data.collectionMeta?.slug),
        inline: false,
    });

    return embed.setTimestamp().setFooter({ text: superbotFooter('Cluster buys') });
}

export function createMintAlertEmbed(data: {
    contract: string;
    chain: string;
    velocity: number;
    timeWindowMin: number;
    collectionName: string;
    collectionMeta?: CollectionMetadata | null;
}) {
    const label = data.collectionName?.trim()
        ? data.collectionName.trim()
        : formatFallbackCollectionName(data.contract);
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.mint)
        .setTitle(`📈 Mint radar — ${label}`)
        .setDescription(alertCategoryLine('High-velocity mint', `${data.velocity} mints / ${data.timeWindowMin} min`))
        .addFields(
            { name: 'Collection', value: label, inline: true },
            { name: 'Chain', value: data.chain, inline: true },
            {
                name: 'Velocity',
                value: `${data.velocity} mints / ${data.timeWindowMin} min`,
                inline: true,
            },
            { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: true },
        );

    const thumb = normalizeImageUrl(data.collectionMeta?.imageUrl);
    if (thumb) embed.setThumbnail(thumb);

    if (data.collectionMeta?.totalSupply) {
        embed.addFields({
            name: 'Total supply',
            value: String(data.collectionMeta.totalSupply),
            inline: true,
        });
    }

    embed.addFields({
        name: '🧠 AI Context Engine',
        value: `*Contract is receiving rapid mint volume. Verify contract age and source before interacting.*`,
    });

    embed.addFields({
        name: 'Links',
        value: markdownCollectionToolkit(data.contract, data.collectionMeta?.slug),
        inline: false,
    });

    embed.setTimestamp().setFooter({ text: superbotFooter('Mint radar') });

    return embed;
}

export function createSweepEmbed(data: {
    collectionName: string;
    contract: string;
    chain: string;
    buyer: string;
    txHash: string;
    itemCount: number;
    totalNative: number;
    currency: string;
    tokenIds?: string[];
    collectionMeta?: CollectionMetadata | null;
    buyerProfile?: WalletProfile | null;
    sampleNftMetas?: NFTMetadata[];
    sampleNftNames?: string[];
    contextualExplanation?: ContextualExplanation | null;
    aiNarrative?: string | null;
}) {
    const collectionLabel = data.collectionName?.trim()
        ? data.collectionName.trim()
        : formatFallbackCollectionName(data.contract);
    const shortTokens =
        data.tokenIds && data.tokenIds.length > 0
            ? data.tokenIds.slice(0, 12).join(', ') + (data.tokenIds.length > 12 ? '…' : '')
            : '—';

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.sweep)
        .setTitle(`💰 Floor sweep — ${collectionLabel}`)
        .setDescription(
            alertCategoryLine('Sweep', `${data.itemCount} items · ${data.totalNative.toFixed(4)} ${data.currency}`),
        );

    const thumb =
        normalizeImageUrl(data.sampleNftMetas?.[0]?.thumbnailUrl ?? data.sampleNftMetas?.[0]?.imageUrl) ||
        normalizeImageUrl(data.collectionMeta?.imageUrl);
    if (thumb) embed.setThumbnail(thumb);

    if (data.buyerProfile) {
        embed.setAuthor({
            name: `Buyer: ${walletDisplay(data.buyerProfile, data.buyer)}`,
            url: data.buyerProfile.openseaUrl,
        });
    }

    embed.addFields(
        { name: 'Collection', value: collectionLabel, inline: true },
        { name: 'Chain', value: data.chain, inline: true },
        { name: 'Items', value: String(data.itemCount), inline: true },
        { name: 'Total', value: `${data.totalNative.toFixed(4)} ${data.currency}`, inline: true },
        {
            name: 'Buyer',
            value: data.buyerProfile?.openseaUrl
                ? `[${walletDisplay(data.buyerProfile, data.buyer)}](${data.buyerProfile.openseaUrl})`
                : `\`${shortAddr(data.buyer)}\``,
            inline: true,
        },
    );

    if (data.buyerProfile?.holdingsCount !== null && data.buyerProfile?.holdingsCount !== undefined) {
        embed.addFields({
            name: 'Buyer holdings',
            value: `${data.buyerProfile.holdingsCount} NFTs`,
            inline: true,
        });
    }

    if (data.sampleNftMetas && data.sampleNftMetas.length > 0) {
        const lines = data.sampleNftMetas
            .slice(0, 3)
            .map((m, i) => {
                const resolved = data.sampleNftNames?.[i]?.trim();
                const name = resolved || m.name || `#${m.tokenId}`;
                if (m.openseaUrl) return `• [${name}](${m.openseaUrl})`;
                return `• ${name}`;
            })
            .join('\n');
        embed.addFields({ name: 'Sample items', value: lines, inline: false });
    } else {
        embed.addFields({ name: 'Token IDs (sample)', value: shortTokens.slice(0, 900), inline: false });
    }

    const collectionSlug =
        data.collectionMeta?.slug ??
        data.sampleNftMetas?.find(m => m.collectionSlug)?.collectionSlug ??
        null;
    if (data.contextualExplanation) {
        appendWhyItMattersEmbed(embed, data.contextualExplanation, data.aiNarrative);
    }

    embed.addFields({
        name: 'Links',
        value: markdownCollectionToolkit(data.contract, collectionSlug),
        inline: false,
    });

    return embed.setTimestamp().setFooter({ text: superbotFooter('Sweeps') });
}

export function createMassListingEmbed(data: {
    collectionName: string;
    contract: string;
    chain: string;
    listingCount: number;
    windowMs: number;
    collectionMeta?: CollectionMetadata | null;
    /** Floor snapshot when the surge fired (omit if unavailable). */
    floorBeforeEth?: number | null;
    floorImpactPending?: boolean;
    contextualExplanation?: ContextualExplanation | null;
    aiNarrative?: string | null;
}) {
    const mins = Math.round(data.windowMs / 60000) || 1;
    const slug = data.collectionMeta?.slug?.trim() || null;

    const floor =
        typeof data.floorBeforeEth === 'number' && data.floorBeforeEth > 0
            ? `${data.floorBeforeEth.toFixed(4)} ETH`
            : null;

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.listing)
        .setTitle(`📊 Listing surge — ${data.collectionName}`)
        .setDescription(
            alertCategoryLine('Listing surge', `${data.listingCount} new listings / ~${mins} min`),
        );

    const thumb = normalizeImageUrl(data.collectionMeta?.imageUrl);
    if (thumb) embed.setThumbnail(thumb);

    embed.addFields(
        { name: 'Collection', value: data.collectionName, inline: true },
        { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: true },
        { name: 'Chain', value: data.chain, inline: true },
        { name: 'New listings (window)', value: `${data.listingCount} / ~${mins} min`, inline: false },
    );

    if (floor) {
        embed.addFields({ name: 'Floor at trigger', value: floor, inline: true });
    }

    if (data.contextualExplanation) {
        appendWhyItMattersEmbed(embed, data.contextualExplanation, data.aiNarrative);
    }

    embed.addFields({ name: 'Links', value: markdownCollectionToolkit(data.contract, slug), inline: false });

    const footerText = data.floorImpactPending
        ? `${superbotFooter('Listing activity')} · Floor check in ~10 min`
        : superbotFooter('Listing activity');
    return embed.setTimestamp().setFooter({ text: footerText });
}

export function createMassDelistEmbed(data: {
    collectionName: string;
    contract: string;
    chain: string;
    delistCount: number;
    windowMs: number;
    sampleOrderIds?: string[];
    collectionMeta?: CollectionMetadata | null;
    floorBeforeEth?: number | null;
    floorImpactPending?: boolean;
    contextualExplanation?: ContextualExplanation | null;
    aiNarrative?: string | null;
}) {
    const mins = Math.round(data.windowMs / 60000) || 1;
    const slug = data.collectionMeta?.slug?.trim() || null;

    const sample =
        data.sampleOrderIds && data.sampleOrderIds.length > 0
            ? data.sampleOrderIds.slice(0, 5).join(', ')
            : '—';

    const floor =
        typeof data.floorBeforeEth === 'number' && data.floorBeforeEth > 0
            ? `${data.floorBeforeEth.toFixed(4)} ETH`
            : null;

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.delist)
        .setTitle(`📊 Delist surge — ${data.collectionName}`)
        .setDescription(
            alertCategoryLine('Delist surge', `${data.delistCount} delists / ~${mins} min`) +
                '\n\nListings were pulled — supply on market is tightening.',
        );

    const thumb = normalizeImageUrl(data.collectionMeta?.imageUrl);
    if (thumb) embed.setThumbnail(thumb);

    embed.addFields(
        { name: 'Collection', value: data.collectionName, inline: true },
        { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: true },
        { name: 'Chain', value: data.chain, inline: true },
        { name: 'Delists (window)', value: `${data.delistCount} / ~${mins} min`, inline: false },
        { name: 'Sample identifiers', value: sample.slice(0, 350) || '—', inline: false },
    );

    if (floor) {
        embed.addFields({ name: 'Floor at trigger', value: floor, inline: true });
    }

    if (data.contextualExplanation) {
        appendWhyItMattersEmbed(embed, data.contextualExplanation, data.aiNarrative);
    }

    embed.addFields({ name: 'Links', value: markdownCollectionToolkit(data.contract, slug), inline: false });

    const footerText = data.floorImpactPending
        ? `${superbotFooter('Delist activity')} · Floor check in ~10 min`
        : superbotFooter('Delist activity');
    return embed.setTimestamp().setFooter({ text: footerText });
}

/** Threaded reply after delayed floor observation (numbers only — no directional labels). */
export function createFloorImpactFollowupEmbed(data: {
    alertType: 'MASS_LISTING' | 'MASS_DELIST';
    contract: string;
    collectionName: string;
    floorBefore: number | null;
    floorAfter: number | null;
    pctChange: number | null;
    contextualExplanation?: ContextualExplanation | null;
    aiNarrative?: string | null;
}) {
    const colorHex = embedColorFloorImpactFollowup(data.alertType, data.pctChange);

    const before =
        typeof data.floorBefore === 'number' && data.floorBefore > 0
            ? `${data.floorBefore.toFixed(4)} ETH`
            : '—';
    const after =
        typeof data.floorAfter === 'number' && data.floorAfter > 0
            ? `${data.floorAfter.toFixed(4)} ETH`
            : '—';
    const ch =
        data.pctChange !== null && !Number.isNaN(data.pctChange)
            ? `${data.pctChange >= 0 ? '+' : ''}${data.pctChange.toFixed(2)}%`
            : '—';

    const coll = data.collectionName?.trim()
        ? data.collectionName.trim()
        : formatFallbackCollectionName(data.contract);

    const embed = new EmbedBuilder()
        .setColor(colorHex)
        .setTitle('Floor observation (10 min later)')
        .setDescription(
            data.contract
                ? `**${coll}** · Contract \`${shortAddr(data.contract)}\``
                : `**${coll}**`,
        )
        .addFields(
            { name: 'Floor before', value: before, inline: true },
            { name: 'Floor now', value: after, inline: true },
            { name: 'Change', value: ch, inline: true },
        )
        .setTimestamp();

    if (data.contextualExplanation) {
        appendWhyItMattersEmbed(embed, data.contextualExplanation, data.aiNarrative);
    }

    embed.setFooter({ text: `SuperBot • ${STANDARD_MARKET_DISCLAIMER}` });

    return embed;
}

function embedColorFloorImpactFollowup(
    alertType: 'MASS_LISTING' | 'MASS_DELIST',
    pct: number | null,
): number {
    if (pct === null || Number.isNaN(pct)) return 0x64748b;
    if (alertType === 'MASS_DELIST') {
        return pct >= 0 ? 0x22c55e : 0xef4444;
    }
    return pct <= 0 ? 0xef4444 : 0x22c55e;
}

export function createHotMintEmbed(data: {
    collectionName: string;
    contract: string;
    chain: string;
    uniqueMinters: number;
    totalMints: number;
    windowMinutes: number;
    velocityPerMin: number;
    pctSupplyMinted?: number | null;
    floorEth?: number | null;
    blockRange: string;
    topMinerLines: string[];
    collectionMeta?: CollectionMetadata | null;
    contextualExplanation?: ContextualExplanation | null;
    aiNarrative?: string | null;
}) {
    const slug = data.collectionMeta?.slug?.trim() || null;
    const pct =
        data.pctSupplyMinted != null && !Number.isNaN(data.pctSupplyMinted)
            ? `${data.pctSupplyMinted.toFixed(2)}%`
            : '—';

    const floorShow =
        typeof data.floorEth === 'number' && data.floorEth > 0 ? `${data.floorEth.toFixed(4)} ETH` : '—';

    const coll = data.collectionName?.trim()
        ? data.collectionName.trim()
        : formatFallbackCollectionName(data.contract);

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.hotMint)
        .setTitle(`🔥 Hot mint — ${coll}`)
        .setDescription(
            alertCategoryLine(
                'Hot mint',
                `${data.uniqueMinters} wallets · ${data.totalMints} mints · ~${data.windowMinutes} min`,
            ),
        );

    const thumb = normalizeImageUrl(data.collectionMeta?.imageUrl);
    if (thumb) embed.setThumbnail(thumb);

    embed.addFields(
        { name: 'Velocity', value: `${data.velocityPerMin.toFixed(2)} mints/min`, inline: true },
        { name: '% of supply minted', value: pct, inline: true },
        { name: 'Current floor', value: floorShow, inline: true },
        {
            name: 'Top minters',
            value: data.topMinerLines.length ? data.topMinerLines.join('\n') : '—',
            inline: false,
        },
        { name: 'Block range', value: data.blockRange, inline: false },
        {
            name: 'Links',
            value: [
                markdownCollectionToolkit(data.contract, slug),
                `[Mint (write)](${links.etherscan.writeContract(data.contract)})`,
            ].join(' · '),
            inline: false,
        },
    );

    if (data.contextualExplanation) {
        appendWhyItMattersEmbed(embed, data.contextualExplanation, data.aiNarrative);
    }

    return embed.setTimestamp().setFooter({
        text: `${superbotFooter('Hot mints')} · Ethereum mainnet`,
    });
}

/** OPPORTUNITY_SPIKE — informational momentum watch; footer disclaimer required for compliance. */
export function createOpportunitySpikeEmbed(data: {
    collectionName: string;
    contract: string;
    chain: string;
    timeWindow: string;
    score: number;
    signal: string;
    confidence: string;
    volumeChange: string;
    tradeCount: string;
    uniqueBuyers: string;
    sweepActivity: string;
    floorChange: string;
    listingPressure: string;
    trackedWalletActivity: string;
    riskFlags: string;
    dataLimitations: string;
    collectionMeta?: CollectionMetadata | null;
    contextualExplanation?: ContextualExplanation | null;
    aiNarrative?: string | null;
}) {
    const coll = data.collectionName?.trim()
        ? data.collectionName.trim()
        : formatFallbackCollectionName(data.contract);
    const slug = data.collectionMeta?.slug?.trim() || null;
    const embed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle('Collection Opportunity Spike Detected')
        .setDescription(`**${coll}** · \`${shortAddr(data.contract)}\``);

    const thumb = normalizeImageUrl(data.collectionMeta?.imageUrl);
    if (thumb) embed.setThumbnail(thumb);

    embed.addFields(
        { name: 'Collection', value: coll, inline: false },
        { name: 'Signal', value: data.signal, inline: true },
        { name: 'Opportunity score', value: String(data.score), inline: true },
        { name: 'Confidence', value: data.confidence, inline: true },
        { name: 'Time window', value: data.timeWindow, inline: true },
        { name: 'Volume change', value: data.volumeChange, inline: true },
        { name: 'Trade count', value: data.tradeCount, inline: true },
        { name: 'Unique buyers', value: data.uniqueBuyers, inline: true },
        { name: 'Sweep activity', value: data.sweepActivity, inline: true },
        { name: 'Floor change', value: data.floorChange, inline: true },
        { name: 'Listing pressure', value: data.listingPressure, inline: true },
        { name: 'Smart / tracked wallet activity', value: data.trackedWalletActivity, inline: false },
        { name: 'Risk flags', value: data.riskFlags, inline: false },
        { name: 'Data limitations', value: data.dataLimitations, inline: false },
        {
            name: 'Links',
            value: markdownCollectionToolkit(data.contract, slug),
            inline: false,
        },
    );

    if (data.contextualExplanation) {
        appendWhyItMattersEmbed(embed, data.contextualExplanation, data.aiNarrative);
    }

    return embed.setTimestamp().setFooter({
        text: `SuperBot • ${STANDARD_MARKET_DISCLAIMER}`,
    });
}

export function createFloorMovementEmbed(data: {
    collectionName: string;
    contract: string;
    floorPrice: number;
    prevFloor: number;
    pctChange: number;
    currency: string;
    direction: 'drop' | 'rise';
    contextualExplanation?: ContextualExplanation | null;
    aiNarrative?: string | null;
}) {
    const isDrop = data.direction === 'drop';
    const title = isDrop ? '📉 Floor dropped' : '📈 Floor climbed';
    const color = isDrop ? '#ef4444' : '#22c55e';

    const cn = data.collectionName?.trim()
        ? data.collectionName.trim()
        : formatFallbackCollectionName(data.contract);

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(`**${cn}**`)
        .addFields(
            { name: 'Floor now', value: `${data.floorPrice} ${data.currency}`, inline: true },
            { name: 'Previous', value: `${data.prevFloor} ${data.currency}`, inline: true },
            { name: 'Move', value: `${data.pctChange.toFixed(2)}%`, inline: true },
            { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: false },
            { name: 'Links', value: markdownCollectionToolkit(data.contract, null), inline: false },
        )
        .setTimestamp();

    if (data.contextualExplanation) {
        appendWhyItMattersEmbed(embed, data.contextualExplanation, data.aiNarrative);
    }

    embed.setFooter({ text: `SuperBot Market Data • ${STANDARD_MARKET_DISCLAIMER}` });
    return embed;
}

export function createFloorUpdateEmbed(data: {
    collectionName: string;
    contract: string;
    floorPrice: number;
    currency: string;
}) {
    const cn = data.collectionName?.trim()
        ? data.collectionName.trim()
        : formatFallbackCollectionName(data.contract);
    const embed = new EmbedBuilder()
        .setColor('#a855f7')
        .setTitle('📊 Floor Price Update')
        .setDescription(`New floor detected for **${cn}**`)
        .addFields(
            { name: 'New Floor', value: `${data.floorPrice} ${data.currency}`, inline: true },
            { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: true },
            { name: 'Links', value: markdownCollectionToolkit(data.contract, null), inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `SuperBot Market Data • ${STANDARD_MARKET_DISCLAIMER}` });

    return embed;
}

/** Markdown: OpenSea (slug collection page, else contract assets URL) · CatchMint · Etherscan token. */
export function markdownCollectionToolkit(contract: string, slug?: string | null): string {
    const parts: string[] = [];
    const s = typeof slug === 'string' ? slug.trim() : '';
    parts.push(
        `[OpenSea](${s ? links.opensea.collection(s) : links.opensea.collectionByContract(contract)})`,
    );
    parts.push(`[CatchMint](${links.catchmint.collection(contract)})`);
    parts.push(`[Etherscan](${links.etherscan.token(contract)})`);
    return parts.join(' · ');
}

/** NFT-scope alerts: OpenSea · CatchMint (collection mint page) · Etherscan NFT; optional Tx hash link. */
function buildExternalLinks(args: {
    contract: string;
    tokenId?: string;
    txHash?: string;
    nftOpenseaUrl?: string | null;
}): string | null {
    const parts: string[] = [];
    if ((args.contract && args.tokenId) || args.nftOpenseaUrl) {
        const openSeaUrl =
            args.nftOpenseaUrl ??
            (args.contract && args.tokenId ? links.opensea.nft(args.contract, args.tokenId) : null);
        if (openSeaUrl) parts.push(`[OpenSea](${openSeaUrl})`);
        if (args.contract) parts.push(`[CatchMint](${links.catchmint.collection(args.contract)})`);
        if (args.contract && args.tokenId) {
            parts.push(`[Etherscan](${links.etherscan.nft(args.contract, args.tokenId)})`);
        }
    }
    if (args.txHash && /^0x[a-fA-F0-9]{64}$/.test(args.txHash)) {
        parts.push(`[Tx](${links.etherscan.tx(args.txHash)})`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
}

function getGradeColor(grade?: string): any {
    switch (grade) {
        case 'Strong Bullish':
            return '#00ff00';
        case 'Weak Bullish':
            return '#90ee90';
        case 'Neutral':
            return '#808080';
        case 'Weak Bearish':
            return '#ffcccb';
        case 'Strong Bearish':
            return '#ff0000';
        case 'High Risk':
            return '#ffa500';
        case 'Suspicious Activity':
            return '#ff00ff';
        default:
            return '#00ff00';
    }
}
