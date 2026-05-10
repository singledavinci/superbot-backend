import { EmbedBuilder } from 'discord.js';
import { IntelligenceReport } from '@superbot/types';
import type {
    NFTMetadata,
    CollectionMetadata,
    WalletProfile,
} from '@superbot/analytics';
import { links } from './links';

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

/** Best display title: "<Collection> <#tokenId>" with sensible fallbacks. */
function nftTitle(
    nftMeta: NFTMetadata | null | undefined,
    collectionMeta: CollectionMetadata | null | undefined,
    contract: string,
    tokenId: string | undefined,
): string {
    const collection =
        collectionMeta?.name ||
        nftMeta?.collectionName ||
        (contract ? shortAddr(contract) : 'Collection');

    if (nftMeta?.name) {
        // OpenSea names usually already include a #N suffix; trust them.
        return nftMeta.name;
    }
    if (tokenId) return `${collection} #${tokenId}`;
    return collection;
}

export function createWhaleBuyEmbed(data: {
    contract: string;
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

    const subject = nftTitle(data.nftMeta, null, data.contract, data.tokenId);
    const title = `${titlePrefix} — ${subject}`;
    const collectionLabel =
        data.nftMeta?.collectionName || shortAddr(data.contract);

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
        { name: 'Token', value: data.tokenId ? `#${data.tokenId}` : '—', inline: true },
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

    embed.addFields({
        name: '🧠 AI Context Engine',
        value: `*${data.intelligence?.context || 'No context available.'}*`,
    });

    if (data.intelligence?.risk) {
        embed.addFields({ name: '⚠️ Risk', value: `*${data.intelligence.risk}*` });
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

    embed
        .setTimestamp()
        .setFooter({
            text: 'SuperBot Intelligence • Not financial advice. Signals are informational and may be incomplete or delayed.',
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
    collectionMeta?: CollectionMetadata | null;
    triggerProfile?: WalletProfile | null;
}) {
    const sample = data.wallets.slice(0, 12).join(', ') + (data.wallets.length > 12 ? '…' : '');
    const collectionLabel = data.collectionMeta?.name || data.collectionName;

    const embed = new EmbedBuilder()
        .setColor('#eab308')
        .setTitle(`🧲 Smart-money cluster — ${collectionLabel}`)
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

    if (data.triggerProfile?.holdingsCount !== null && data.triggerProfile?.holdingsCount !== undefined) {
        embed.addFields({
            name: 'Trigger wallet holdings',
            value: `${data.triggerProfile.holdingsCount} NFTs`,
            inline: true,
        });
    }

    embed.addFields({
        name: 'Links',
        value: markdownCollectionToolkit(data.contract, data.collectionMeta?.slug),
        inline: false,
    });

    return embed
        .setTimestamp()
        .setFooter({ text: 'SuperBot Smart-Money • Not financial advice' });
}

export function createMintAlertEmbed(data: {
    contract: string;
    chain: string;
    velocity: number;
    timeWindowMin: number;
    collectionMeta?: CollectionMetadata | null;
}) {
    const label = data.collectionMeta?.name || shortAddr(data.contract);
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

    embed
        .setTimestamp()
        .setFooter({
            text: 'SuperBot Mint Radar • Not financial advice. Signals are informational and may be incomplete or delayed.',
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
}) {
    const collectionLabel = data.collectionMeta?.name || data.collectionName;
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
            .map(m => {
                const name = m.name || `#${m.tokenId}`;
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
    embed.addFields({
        name: 'Links',
        value: markdownCollectionToolkit(data.contract, collectionSlug),
        inline: false,
    });

    return embed
        .setTimestamp()
        .setFooter({ text: 'SuperBot Market Intelligence • Not financial advice' });
}

export function createMassListingEmbed(data: {
    collectionName: string;
    contract: string;
    chain: string;
    listingCount: number;
    windowMs: number;
    collectionMeta?: CollectionMetadata | null;
}) {
    const mins = Math.round(data.windowMs / 60000) || 1;
    const slug = data.collectionMeta?.slug?.trim() || null;
    return new EmbedBuilder()
        .setColor('#38bdf8')
        .setTitle('📣 Listing surge')
        .setDescription(`Many new listings appeared in a short window.`)
        .addFields(
            { name: 'Collection', value: data.collectionName, inline: true },
            { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: true },
            { name: 'Chain', value: data.chain, inline: true },
            { name: 'New listings (window)', value: `${data.listingCount} / ~${mins} min`, inline: false },
            { name: 'Links', value: markdownCollectionToolkit(data.contract, slug), inline: false },
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Market Intelligence • Not financial advice' });
}

export function createFloorMovementEmbed(data: {
    collectionName: string;
    contract: string;
    floorPrice: number;
    prevFloor: number;
    pctChange: number;
    currency: string;
    direction: 'drop' | 'rise';
}) {
    const isDrop = data.direction === 'drop';
    const title = isDrop ? '📉 Floor dropped' : '📈 Floor climbed';
    const color = isDrop ? '#ef4444' : '#22c55e';

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(`**${data.collectionName}**`)
        .addFields(
            { name: 'Floor now', value: `${data.floorPrice} ${data.currency}`, inline: true },
            { name: 'Previous', value: `${data.prevFloor} ${data.currency}`, inline: true },
            { name: 'Move', value: `${data.pctChange.toFixed(2)}%`, inline: true },
            { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: false },
            { name: 'Links', value: markdownCollectionToolkit(data.contract, null), inline: false },
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Market Data • Not financial advice' });
}

export function createFloorUpdateEmbed(data: {
    collectionName: string;
    contract: string;
    floorPrice: number;
    currency: string;
}) {
    const embed = new EmbedBuilder()
        .setColor('#a855f7')
        .setTitle('📊 Floor Price Update')
        .setDescription(`New floor detected for **${data.collectionName}**`)
        .addFields(
            { name: 'New Floor', value: `${data.floorPrice} ${data.currency}`, inline: true },
            { name: 'Contract', value: `\`${shortAddr(data.contract)}\``, inline: true },
            { name: 'Links', value: markdownCollectionToolkit(data.contract, null), inline: false },
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Market Data • Not financial advice' });

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
