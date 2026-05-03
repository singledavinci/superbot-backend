"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWhaleBuyEmbed = createWhaleBuyEmbed;
exports.createMintAlertEmbed = createMintAlertEmbed;
const discord_js_1 = require("discord.js");
function createWhaleBuyEmbed(data) {
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(getGradeColor(data.intelligence?.grade))
        .setTitle('🚨 Whale Entry Detected')
        .setDescription(`**Signal:** \`${data.intelligence?.grade || 'Neutral'}\``)
        .addFields({ name: 'Collection', value: `\`${data.contract}\``, inline: true }, { name: 'Whale', value: `\`${data.label || data.wallet}\``, inline: true }, { name: 'Token ID', value: data.tokenId, inline: true }, { name: '🧠 AI Context Engine', value: `*${data.intelligence?.context || 'No context available.'}*` })
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
function createMintAlertEmbed(data) {
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#ffcc00') // Gold for mints
        .setTitle('🚀 High-Velocity Mint Detected')
        .setDescription(`**Signal:** \`Mint Radar Alert\``)
        .addFields({ name: 'Collection', value: `\`${data.contract}\``, inline: true }, { name: 'Chain', value: data.chain, inline: true }, { name: 'Velocity', value: `${data.velocity} mints / ${data.timeWindowMin} min`, inline: true }, { name: '🧠 AI Context Engine', value: `*Contract is receiving rapid mint volume. Verify contract age and source before interacting.*` })
        .setTimestamp()
        .setFooter({ text: 'SuperBot Mint Radar' });
    return embed;
}
function getGradeColor(grade) {
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
