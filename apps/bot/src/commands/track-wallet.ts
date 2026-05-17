import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';
import { startWalletSetupWizard } from '../lib/walletSetupWizard';
import { EPHEMERAL_REPLY } from '../lib/interactionReply';

export const data = new SlashCommandBuilder()
    .setName('track-wallet')
    .setDescription('Track a whale wallet — paste the address, then confirm in the menu.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
        opt.setName('address').setDescription('Ethereum wallet (0x…)').setRequired(true),
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply(EPHEMERAL_REPLY);

    const address = interaction.options.getString('address', true).toLowerCase().trim();
    const guildId = interaction.guildId!;

    if (!ethers.isAddress(address)) {
        return interaction.editReply('Invalid Ethereum address. Use a valid `0x…` address.');
    }

    try {
        const guild = await prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild) {
            return interaction.editReply('Server not set up yet. Run `/setup` first.');
        }

        const payload = await startWalletSetupWizard(guildId, interaction.user.id, address);
        await interaction.editReply(payload);
    } catch (err: unknown) {
        console.error('[/track-wallet] Error:', err);
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Error: ${msg}`);
    }
}
