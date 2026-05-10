import { EmbedBuilder } from 'discord.js';
import type { IntelligenceReport, ContextualExplanation } from '@superbot/types';
import {
    formatFallbackCollectionName,
    type NFTMetadata,
    type CollectionMetadata,
    type WalletProfile,
} from '@superbot/analytics';
import { links } from './links';

/** Must appear on informational market/embed outputs. */
export const STANDARD_MARKET_DISCLAIMER =
    'Not financial advice. Signals are informational and may be incomplete or delayed.';

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

    embed.setTimestamp().setFooter({
        text: `SuperBot Intelligence • ${STANDARD_MARKET_DISCLAIMER}`,
    });

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
        .setColor('#eab308')
        .setTitle(`🧲 Smart-money cluster — ${headline}`)
        .setDescription(
            `**${data.wallets.length}** distinct watched wallets bought this collection within **~${data.windowMinutes} min**.`,
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

    return embed.setTimestamp().setFooter({ text: `SuperBot Smart-Money • ${STANDARD_MARKET_DISCLAIMER}` });
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
        .setColor('#ffcc00')
        .setTitle(`🚀 High-Velocity Mint — ${label}`)
        .setDescription(`**Signal:** \`Mint Radar Alert\``)
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

    embed.setTimestamp().setFooter({
        text: `SuperBot Mint Radar • ${STANDARD_MARKET_DISCLAIMER}`,
    });

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
        .setColor('#f97316')
        .setTitle(`🧹 Floor sweep — ${collectionLabel}`)
        .setDescription(`Multiple items bought in one transaction (possible floor sweep).`);

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

    return embed.setTimestamp().setFooter({ text: `SuperBot Market Intelligence • ${STANDARD_MARKET_DISCLAIMER}` });
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
        .setColor('#38bdf8')
        .setTitle(`📣 Listing surge — ${data.collectionName}`)
        .setDescription(
            `**${data.collectionName}** — Many new listings appeared in a short window.`,
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

    const base = `SuperBot Market Intelligence • ${STANDARD_MARKET_DISCLAIMER}`;
    const footerText = data.floorImpactPending
        ? `${base} • Checking floor impact in ~10 minutes.`
        : base;
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
        .setColor('#34d399')
        .setTitle(`✨ Delist surge — ${data.collectionName}`)
        .setDescription(
            `**${data.collectionName}** — **Delist surge:** ${data.delistCount} NFTs pulled from marketplace listings in ~${mins} min — tighter supply.`,
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

    const base = `SuperBot Market Intelligence • ${STANDARD_MARKET_DISCLAIMER}`;
    const footerText = data.floorImpactPending
        ? `${base} • Checking floor impact in ~10 minutes.`
        : base;
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
        .setColor('#f97316')
        .setTitle(`🔥 Hot Mint — ${coll}`)
        .setDescription(
            `**${coll}** — **${data.uniqueMinters}** wallets minted **${data.totalMints}** tokens in **~${data.windowMinutes}** minutes.`,
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
        text: `SuperBot Mint Intelligence • ${STANDARD_MARKET_DISCLAIMER} • Ethereum only`,
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
