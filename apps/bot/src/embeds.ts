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

    return embed;
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
