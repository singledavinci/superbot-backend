import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';
import { STANDARD_MARKET_DISCLAIMER } from '../embeds';

export const data = new SlashCommandBuilder()
    .setName('watchlist')
    .setDescription('Personal watchlist (stored per Discord user)')
    .addSubcommand(sc =>
        sc
            .setName('add-wallet')
            .setDescription('Pin a wallet')
            .addStringOption(o =>
                o.setName('address').setDescription('0x wallet').setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('add-collection')
            .setDescription('Pin a collection contract')
            .addStringOption(o =>
                o.setName('address').setDescription('Contract address').setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('remove')
            .setDescription('Remove wallet or collection from watchlist')
            .addStringOption(o =>
                o
                    .setName('kind')
                    .setDescription('Type')
                    .setRequired(true)
                    .addChoices(
                        { name: 'wallet', value: 'wallet' },
                        { name: 'collection', value: 'collection' },
                    ),
            )
            .addStringOption(o =>
                o.setName('address').setDescription('Address to forget').setRequired(true),
            ),
    )
    .addSubcommand(sc => sc.setName('list').setDescription('Show your watchlist'));

export async function execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();

    await interaction.deferReply({ ephemeral: true });

    let user = await prisma.user.findUnique({
        where: { discordId: interaction.user.id },
    });
    if (!user) {
        user = await prisma.user.create({ data: { discordId: interaction.user.id } });
    }

    const foot = STANDARD_MARKET_DISCLAIMER;

    if (sub === 'list') {
        const rows = await prisma.watchlist.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: 25,
        });
        const embed = new EmbedBuilder()
            .setTitle('Your watchlist')
            .setColor(0x6366f1)
            .setDescription(
                rows.length
                    ? rows.map(r => `• **${r.targetType}** \`${r.targetAddress}\``).join('\n')
                    : 'Empty.',
            )
            .setFooter({ text: foot });

        await interaction.editReply({ embeds: [embed] });
        return;
    }

    const raw = interaction.options.getString('address', true).trim();

    if (sub === 'add-wallet' || sub === 'add-collection') {
        if (!ethers.isAddress(raw)) {
            await interaction.editReply('Invalid address.');
            return;
        }

        const targetType = sub === 'add-wallet' ? 'wallet' : 'collection';

        await prisma.watchlist.upsert({
            where: {
                userId_targetType_targetAddress: {
                    userId: user.id,
                    targetType,
                    targetAddress: ethers.getAddress(raw).toLowerCase(),
                },
            },
            update: {},
            create: {
                userId: user.id,
                targetType,
                targetAddress: ethers.getAddress(raw).toLowerCase(),
            },
        });

        await interaction.editReply(`${targetType} saved. (${foot})`);
        return;
    }

    if (!ethers.isAddress(raw)) {
        await interaction.editReply('Invalid address.');
        return;
    }
    const kind = interaction.options.getString('kind', true) as 'wallet' | 'collection';
    const addr = ethers.getAddress(raw).toLowerCase();

    const del = await prisma.watchlist.deleteMany({
        where: { userId: user.id, targetType: kind, targetAddress: addr },
    });

    await interaction.editReply(
        del.count ? `Removed ${kind} watch.` : `No matching ${kind} entry. (${foot})`,
    );
}
