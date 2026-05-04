"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const ethers_1 = require("ethers");
const db_1 = require("../../db");
exports.data = new discord_js_1.SlashCommandBuilder()
    .setName('untrack-wallet')
    .setDescription('Stop tracking a whale wallet in this server.')
    .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('address')
    .setDescription('Ethereum wallet address to untrack (0x...)')
    .setRequired(true));
async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const address = interaction.options.getString('address', true).toLowerCase().trim();
    const guildId = interaction.guildId;
    if (!ethers_1.ethers.isAddress(address)) {
        return interaction.editReply('❌ Invalid Ethereum address.');
    }
    try {
        const guild = await db_1.prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild)
            return interaction.editReply('❌ Server not set up. Run `/setup` first.');
        const wallet = await db_1.prisma.trackedWallet.findUnique({
            where: { address_guildId: { address, guildId: guild.id } }
        });
        if (!wallet) {
            return interaction.editReply(`⚠️ Wallet \`${address.slice(0, 10)}...\` is not being tracked in this server.`);
        }
        await db_1.prisma.trackedWallet.delete({
            where: { address_guildId: { address, guildId: guild.id } }
        });
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#f43f5e')
            .setTitle('🗑️ Wallet Untracked')
            .addFields({ name: 'Address', value: `\`${address}\``, inline: false }, { name: 'Label', value: wallet.label ?? '—', inline: true })
            .setFooter({ text: 'SuperBot Intelligence' })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    }
    catch (err) {
        console.error('[/untrack-wallet] Error:', err);
        await interaction.editReply(`❌ Error: ${err.message ?? 'Unknown error'}`);
    }
}
