"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const ethers_1 = require("ethers");
const db_1 = require("../../db");
exports.data = new discord_js_1.SlashCommandBuilder()
    .setName('untrack-collection')
    .setDescription('Stop tracking an NFT collection in this server.')
    .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('contract')
    .setDescription('Collection contract address to untrack (0x...)')
    .setRequired(true));
async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const contract = interaction.options.getString('contract', true).toLowerCase().trim();
    const guildId = interaction.guildId;
    if (!ethers_1.ethers.isAddress(contract)) {
        return interaction.editReply('❌ Invalid contract address.');
    }
    try {
        const guild = await db_1.prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild)
            return interaction.editReply('❌ Server not set up. Run `/setup` first.');
        const collection = await db_1.prisma.trackedCollection.findUnique({
            where: { contractAddress_guildId: { contractAddress: contract, guildId: guild.id } }
        });
        if (!collection) {
            return interaction.editReply(`⚠️ Collection \`${contract.slice(0, 10)}...\` is not being tracked in this server.`);
        }
        await db_1.prisma.trackedCollection.delete({
            where: { contractAddress_guildId: { contractAddress: contract, guildId: guild.id } }
        });
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#f43f5e')
            .setTitle('🗑️ Collection Untracked')
            .addFields({ name: 'Collection', value: collection.name, inline: true }, { name: 'Contract', value: `\`${contract.slice(0, 12)}...\``, inline: true })
            .setFooter({ text: 'SuperBot Intelligence' })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    }
    catch (err) {
        console.error('[/untrack-collection] Error:', err);
        await interaction.editReply(`❌ Error: ${err.message ?? 'Unknown error'}`);
    }
}
