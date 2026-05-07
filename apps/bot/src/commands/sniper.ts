import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '@superbot/database';

export const data = new SlashCommandBuilder()
    .setName('sniper')
    .setDescription('Configure your automated NFT sniper')
    .addBooleanOption(opt => opt.setName('enabled').setDescription('Toggle auto-mint on/off'))
    .addNumberOption(opt => opt.setName('max-price').setDescription('Maximum ETH to pay per mint (slippage guard)'))
    .addNumberOption(opt => opt.setName('gas-buffer').setDescription('Extra Gwei to add to the base fee for faster inclusion'));

export async function execute(interaction: ChatInputCommandInteraction) {
    const userId = interaction.user.id;
    const enabled = interaction.options.getBoolean('enabled');
    const maxPrice = interaction.options.getNumber('max-price');
    const gasBuffer = interaction.options.getNumber('gas-buffer');

    let user = await prisma.user.findUnique({ where: { discordId: userId } });
    if (!user) {
        user = await prisma.user.create({ data: { discordId: userId } });
    }

    const updated = await prisma.user.update({
        where: { discordId: userId },
        data: {
            autoMintEnabled: enabled ?? user.autoMintEnabled,
            maxMintPrice: maxPrice ?? user.maxMintPrice,
            gasBufferGwei: gasBuffer ?? user.gasBufferGwei
        }
    });

    const embed = new EmbedBuilder()
        .setTitle('🎯 Sniper Settings Updated')
        .addFields(
            { name: 'Auto-Mint', value: updated.autoMintEnabled ? '✅ ENABLED' : '❌ DISABLED', inline: true },
            { name: 'Max Price', value: `${updated.maxMintPrice} ETH`, inline: true },
            { name: 'Gas Buffer', value: `${updated.gasBufferGwei} Gwei`, inline: true }
        )
        .setColor(updated.autoMintEnabled ? 0x00FF00 : 0xFF0000);

    return interaction.reply({ embeds: [embed] });
}
