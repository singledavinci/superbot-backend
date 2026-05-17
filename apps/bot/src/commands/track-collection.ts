import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';
import { startCollectionSetupWizard } from '../lib/collectionSetupWizard';

export const data = new SlashCommandBuilder()
    .setName('track-collection')
    .setDescription('Track a collection — paste the contract, then use the setup menu.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
        opt
            .setName('contract')
            .setDescription('Collection contract address (0x…)')
            .setRequired(true),
    )
    .addStringOption(opt =>
        opt
            .setName('name')
            .setDescription('Optional display name if auto-detect fails')
            .setRequired(false),
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const contract = interaction.options.getString('contract', true).toLowerCase().trim();
    const nameHint = interaction.options.getString('name');
    const guildId = interaction.guildId!;

    if (!ethers.isAddress(contract)) {
        return interaction.editReply('Invalid contract address. Use a valid `0x…` address.');
    }

    try {
        const guild = await prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild) {
            return interaction.editReply('Server not set up yet. Run `/setup` first, then try again.');
        }

        const payload = await startCollectionSetupWizard(guildId, interaction.user.id, contract, nameHint);
        await interaction.editReply(payload);
    } catch (err: unknown) {
        console.error('[/track-collection] Error:', err);
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Error: ${msg}`);
    }
}
