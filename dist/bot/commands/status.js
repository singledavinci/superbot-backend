"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const db_1 = require("../../db");
exports.data = new discord_js_1.SlashCommandBuilder()
    .setName('status')
    .setDescription('Show SuperBot configuration status for this server.');
async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    try {
        const guild = await db_1.prisma.guild.findUnique({
            where: { discordId: guildId },
            include: {
                alertChannels: true,
                trackedWallets: true,
                trackedCollections: true,
            }
        });
        if (!guild) {
            return interaction.editReply('❌ This server has not been set up yet. Run `/setup` to get started.');
        }
        const walletLines = guild.trackedWallets.length > 0
            ? guild.trackedWallets.map(w => `• \`${w.address.slice(0, 10)}...\` ${w.label ? `(${w.label})` : ''}`).join('\n')
            : '_None tracked yet_';
        const collectionLines = guild.trackedCollections.length > 0
            ? guild.trackedCollections.map(c => `• ${c.name} \`${c.contractAddress.slice(0, 10)}...\``).join('\n')
            : '_None tracked yet_';
        const channelLines = guild.alertChannels.length > 0
            ? guild.alertChannels.map(ch => `• ${ch.alertType} → <#${ch.discordChannelId}>`).join('\n')
            : '_No channels configured_';
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#00f0ff')
            .setTitle(`⚡ SuperBot — ${interaction.guild.name}`)
            .setDescription(`Plan: **${guild.planTier}** | Channels: **${guild.alertChannels.length}** | Wallets: **${guild.trackedWallets.length}** | Collections: **${guild.trackedCollections.length}**`)
            .addFields({ name: '📡 Alert Channels', value: channelLines, inline: false }, { name: '🐳 Tracked Wallets', value: walletLines, inline: false }, { name: '🖼️ Tracked Collections', value: collectionLines, inline: false })
            .setFooter({ text: 'SuperBot Intelligence • Use /track-wallet and /track-collection to add more.' })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    }
    catch (err) {
        console.error('[/status] Error:', err);
        await interaction.editReply(`❌ Error: ${err.message ?? 'Unknown error'}`);
    }
}
