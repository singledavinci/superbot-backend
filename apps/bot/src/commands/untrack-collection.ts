import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';

export const data = new SlashCommandBuilder()
    .setName('untrack-collection')
    .setDescription('Stop tracking an NFT collection in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
        opt.setName('contract')
            .setDescription('Collection contract address to untrack (0x...)')
            .setRequired(true)
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const contract = interaction.options.getString('contract', true).toLowerCase().trim();
    const guildId  = interaction.guildId!;

    if (!ethers.isAddress(contract)) {
        return interaction.editReply('❌ Invalid contract address.');
    }

    try {
        const guild = await prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild) return interaction.editReply('❌ Server not set up. Run `/setup` first.');

        const collection = await prisma.trackedCollection.findUnique({
            where: { contractAddress_guildId: { contractAddress: contract, guildId: guild.id } }
        });

        if (!collection) {
            return interaction.editReply(`⚠️ Collection \`${contract.slice(0, 10)}...\` is not being tracked in this server.`);
        }

        await prisma.trackedCollection.delete({
            where: { contractAddress_guildId: { contractAddress: contract, guildId: guild.id } }
        });

        const embed = new EmbedBuilder()
            .setColor('#f43f5e')
            .setTitle('🗑️ Collection Untracked')
            .addFields(
                { name: 'Collection', value: collection.name, inline: true },
                { name: 'Contract',   value: `\`${contract.slice(0, 12)}...\``, inline: true },
            )
            .setFooter({ text: 'SuperBot Intelligence' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (err: any) {
        console.error('[/untrack-collection] Error:', err);
        await interaction.editReply(`❌ Error: ${err.message ?? 'Unknown error'}`);
    }
}
