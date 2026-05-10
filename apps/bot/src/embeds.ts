import { EmbedBuilder } from 'discord.js';
import { IntelligenceReport } from '@superbot/types';

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
}) {
    let title = '🚨 Whale Entry Detected';
    let color = getGradeColor(data.intelligence?.grade);

    if (data.alertType === 'WHALE_SALE') {
        title = '📉 Whale Sale Detected';
        color = '#ff4444';
    } else if (data.alertType === 'WHALE_MINT') {
        title = '🚀 Whale Mint Detected';
        color = '#00ffee';
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(`**Signal:** \`${data.intelligence?.grade || 'Neutral'}\``)
        .addFields(
            { name: 'Collection', value: `\`${data.contract}\``, inline: true },
            { name: 'Whale', value: `\`${data.label || data.wallet}\``, inline: true },
            { name: 'Token ID', value: data.tokenId, inline: true }
        );

    if (data.price && data.price !== '0') {
        embed.addFields(
            { name: 'Price', value: `${data.price} ${data.currency}`, inline: true },
            { name: 'Market', value: data.marketplace || 'Unknown', inline: true },
            { name: '\u200B', value: '\u200B', inline: true }
        );
    }

    embed.addFields({ name: '🧠 AI Context Engine', value: `*${data.intelligence?.context || 'No context available.'}*` });
    
    embed.setTimestamp()
        .setFooter({ text: 'SuperBot Intelligence • Not financial advice. Signals are informational and may be incomplete or delayed.' });

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
}) {
    const sample = data.wallets.slice(0, 12).join(', ') + (data.wallets.length > 12 ? '…' : '');
    return new EmbedBuilder()
        .setColor('#eab308')
        .setTitle('🧲 Smart-money cluster (tracked wallets)')
        .setDescription(
            `**${data.wallets.length}** distinct watched wallets bought this collection within **~${data.windowMinutes} min**.`,
        )
        .addFields(
            { name: 'Collection', value: data.collectionName, inline: true },
            { name: 'Chain', value: data.chain, inline: true },
            { name: 'Contract', value: `\`${data.contract.slice(0, 12)}…\``, inline: true },
            { name: 'Wallets (sample)', value: sample.slice(0, 900) || '—', inline: false },
            {
                name: 'Latest buy (tx)',
                value: /^0x[a-fA-F0-9]{64}$/.test(data.triggerTxHash)
                    ? `[Etherscan](https://etherscan.io/tx/${data.triggerTxHash})`
                    : 'Not available',
                inline: true,
            },
            { name: 'Trigger buyer', value: `\`${data.triggerBuyer.slice(0, 10)}…\``, inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Smart-Money • Not financial advice' });
}

export function createMintAlertEmbed(data: {
    contract: string;
    chain: string;
    velocity: number;
    timeWindowMin: number;
}) {
    const embed = new EmbedBuilder()
        .setColor('#ffcc00')
        .setTitle('🚀 High-Velocity Mint Detected')
        .setDescription(`**Signal:** \`Mint Radar Alert\``)
        .addFields(
            { name: 'Collection', value: `\`${data.contract}\``, inline: true },
            { name: 'Chain', value: data.chain, inline: true },
            { name: 'Velocity', value: `${data.velocity} mints / ${data.timeWindowMin} min`, inline: true },
            { name: '🧠 AI Context Engine', value: `*Contract is receiving rapid mint volume. Verify contract age and source before interacting.*` }
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Mint Radar • Not financial advice. Signals are informational and may be incomplete or delayed.' });

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
}) {
    const shortTokens =
        data.tokenIds && data.tokenIds.length > 0
            ? data.tokenIds.slice(0, 12).join(', ') + (data.tokenIds.length > 12 ? '…' : '')
            : '—';

    return new EmbedBuilder()
        .setColor('#f97316')
        .setTitle('🧹 Floor sweep detected')
        .setDescription(`Multiple items bought in one transaction (possible floor sweep).`)
        .addFields(
            { name: 'Collection', value: data.collectionName, inline: true },
            { name: 'Chain', value: data.chain, inline: true },
            { name: 'Items', value: String(data.itemCount), inline: true },
            { name: 'Total', value: `${data.totalNative.toFixed(4)} ${data.currency}`, inline: true },
            { name: 'Buyer', value: `\`${data.buyer}\``, inline: false },
            { name: 'Token IDs (sample)', value: shortTokens.slice(0, 900), inline: false },
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Market Intelligence • Not financial advice' });
}

export function createMassListingEmbed(data: {
    collectionName: string;
    contract: string;
    chain: string;
    listingCount: number;
    windowMs: number;
}) {
    const mins = Math.round(data.windowMs / 60000) || 1;
    return new EmbedBuilder()
        .setColor('#38bdf8')
        .setTitle('📣 Listing surge')
        .setDescription(`Many new listings appeared in a short window.`)
        .addFields(
            { name: 'Collection', value: data.collectionName, inline: true },
            { name: 'Contract', value: `\`${data.contract.slice(0, 10)}…\``, inline: true },
            { name: 'Chain', value: data.chain, inline: true },
            { name: 'New listings (window)', value: `${data.listingCount} / ~${mins} min`, inline: false },
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
            { name: 'Contract', value: `\`${data.contract.slice(0, 12)}…\``, inline: false },
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
            { name: 'Contract', value: `\`${data.contract.slice(0, 10)}...\``, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Market Data • Not financial advice' });

    return embed;
}

function getGradeColor(grade?: string): any {
    switch (grade) {
        case 'Strong Bullish': return '#00ff00';
        case 'Weak Bullish': return '#90ee90';
        case 'Neutral': return '#808080';
        case 'Weak Bearish': return '#ffcccb';
        case 'Strong Bearish': return '#ff0000';
        case 'High Risk': return '#ffa500';
        case 'Suspicious Activity': return '#ff00ff';
        default: return '#00ff00';
    }
}
