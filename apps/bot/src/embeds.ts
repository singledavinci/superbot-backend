import { EmbedBuilder } from 'discord.js';
import { IntelligenceReport } from '@superbot/types';

export function createWhaleBuyEmbed(data: {
    contract: string;
    wallet: string;
    tokenId: string;
    txHash: string;
    label?: string | null;
    intelligence?: IntelligenceReport;
}) {
    const embed = new EmbedBuilder()
        .setColor(getGradeColor(data.intelligence?.grade))
        .setTitle('🚨 Whale Entry Detected')
        .setDescription(`**Signal:** \`${data.intelligence?.grade || 'Neutral'}\``)
        .addFields(
            { name: 'Collection', value: `\`${data.contract}\``, inline: true },
            { name: 'Whale', value: `\`${data.label || data.wallet}\``, inline: true },
            { name: 'Token ID', value: data.tokenId, inline: true },
            { name: '🧠 AI Context Engine', value: `*${data.intelligence?.context || 'No context available.'}*` }
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Intelligence' });

    if (data.intelligence?.risk) {
        embed.addFields({ name: '⚠️ Risk', value: `*${data.intelligence.risk}*` });
    }
    if (data.intelligence?.nextWatch) {
        embed.addFields({ name: '📈 Next Watch', value: `*${data.intelligence.nextWatch}*` });
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
        .setColor('#ffcc00') // Gold for mints
        .setTitle('🚀 High-Velocity Mint Detected')
        .setDescription(`**Signal:** \`Mint Radar Alert\``)
        .addFields(
            { name: 'Collection', value: `\`${data.contract}\``, inline: true },
            { name: 'Chain', value: data.chain, inline: true },
            { name: 'Velocity', value: `${data.velocity} mints / ${data.timeWindowMin} min`, inline: true },
            { name: '🧠 AI Context Engine', value: `*Contract is receiving rapid mint volume. Verify contract age and source before interacting.*` }
        )
        .setTimestamp()
        .setFooter({ text: 'SuperBot Mint Radar' });

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
