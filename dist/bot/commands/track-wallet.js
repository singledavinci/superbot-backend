"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const ethers_1 = require("ethers");
const db_1 = require("../../db");
exports.data = new discord_js_1.SlashCommandBuilder()
    .setName('track-wallet')
    .setDescription('Track a whale wallet and route alerts to a channel.')
    .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('address')
    .setDescription('Ethereum wallet address (0x...)')
    .setRequired(true))
    .addStringOption(opt => opt.setName('label')
    .setDescription('Friendly label for this wallet (e.g. "Pranksy")')
    .setRequired(false))
    .addStringOption(opt => opt.setName('channel-id')
    .setDescription('Discord channel ID to route alerts to (uses default if omitted)')
    .setRequired(false));
async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const address = interaction.options.getString('address', true).toLowerCase().trim();
    const label = interaction.options.getString('label') ?? null;
    const channelId = interaction.options.getString('channel-id') ?? null;
    const guildId = interaction.guildId;
    // Validate ETH address
    if (!ethers_1.ethers.isAddress(address)) {
        return interaction.editReply('❌ Invalid Ethereum address. Please provide a valid `0x...` address.');
    }
    try {
        const guild = await db_1.prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild) {
            return interaction.editReply('❌ This server has not been set up yet. Run `/setup` first.');
        }
        // Resolve target channel
        let targetChannelId = channelId;
        if (!targetChannelId) {
            const defaultChannel = await db_1.prisma.alertChannel.findFirst({
                where: { guildId: guild.id, alertType: 'WHALE_BUY' }
            });
            targetChannelId = defaultChannel?.discordChannelId ?? null;
        }
        if (!targetChannelId) {
            return interaction.editReply('❌ No whale channel configured. Run `/setup` or provide a `channel-id`.');
        }
        // Upsert tracked wallet
        const wallet = await db_1.prisma.trackedWallet.upsert({
            where: { address_guildId: { address, guildId: guild.id } },
            create: { guildId: guild.id, address, label, alertChannelId: targetChannelId },
            update: { label, alertChannelId: targetChannelId },
        });
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#10b981')
            .setTitle('🐳 Wallet Now Tracked')
            .addFields({ name: 'Address', value: `\`${address}\``, inline: false }, { name: 'Label', value: label ?? '—', inline: true }, { name: 'Alerts →', value: `<#${targetChannelId}>`, inline: true })
            .setFooter({ text: 'SuperBot Intelligence' })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    }
    catch (err) {
        console.error('[/track-wallet] Error:', err);
        await interaction.editReply(`❌ Error: ${err.message ?? 'Unknown error'}`);
    }
}
