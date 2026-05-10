import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '@superbot/database';
import { Wallet, formatEther } from 'ethers';

export const data = new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage your SuperBot sniping wallet')
    .addSubcommand(sub => sub
        .setName('status')
        .setDescription('Check your sniping wallet address and balance'))
    .addSubcommand(sub => sub
        .setName('generate')
        .setDescription('Generate a new secure sniping wallet for this account'))
    .addSubcommand(sub => sub
        .setName('export')
        .setDescription('Reveal your private key (use with caution!)'));

export async function execute(interaction: ChatInputCommandInteraction) {
    const userId = interaction.user.id;
    
    // Find or create user
    let user = await prisma.user.findUnique({
        where: { discordId: userId }
    });

    if (!user) {
        user = await prisma.user.create({
            data: { discordId: userId }
        });
    }

    const subcommand = interaction.options.getSubcommand();

    const embed = new EmbedBuilder()
        .setTitle('⚠️ Sniping Feature Disabled')
        .setDescription('Sniping and sub-wallet features are currently disabled for security reasons. SuperBot will **never** ask you for your seed phrase or private keys.')
        .setColor(0xFF0000)
        .setFooter({ text: 'SuperBot Security • Not financial advice' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
}
