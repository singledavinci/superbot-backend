import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';

export const data = new SlashCommandBuilder()
    .setName('untrack-wallet')
    .setDescription('Stop tracking a whale wallet in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
        opt.setName('address')
            .setDescription('Ethereum wallet address to untrack (0x...)')
            .setRequired(true)
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const address = interaction.options.getString('address', true).toLowerCase().trim();
    const guildId = interaction.guildId!;

    if (!ethers.isAddress(address)) {
        return interaction.editReply('❌ Invalid Ethereum address.');
    }

    try {
        const guild = await prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild) return interaction.editReply('❌ Server not set up. Run `/setup` first.');

        const wallet = await prisma.trackedWallet.findUnique({
            where: { address_guildId: { address, guildId: guild.id } }
        });

        if (!wallet) {
            return interaction.editReply(`⚠️ Wallet \`${address.slice(0, 10)}...\` is not being tracked in this server.`);
        }

        await prisma.trackedWallet.delete({
            where: { address_guildId: { address, guildId: guild.id } }
        });

        const embed = new EmbedBuilder()
            .setColor('#f43f5e')
            .setTitle('🗑️ Wallet Untracked')
            .addFields(
                { name: 'Address', value: `\`${address}\``, inline: false },
                { name: 'Label',   value: wallet.label ?? '—', inline: true },
            )
            .setFooter({ text: 'SuperBot Intelligence' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (err: any) {
        console.error('[/untrack-wallet] Error:', err);
        await interaction.editReply(`❌ Error: ${err.message ?? 'Unknown error'}`);
    }
}
