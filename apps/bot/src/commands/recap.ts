import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import { prisma } from '@superbot/database';
import { STANDARD_MARKET_DISCLAIMER } from '../embeds';

export const data = new SlashCommandBuilder()
    .setName('recap')
    .setDescription('Summarize recent delivered alerts (counts only — no phantom rankings)')
    .addStringOption(o =>
        o
            .setName('period')
            .setDescription('Window')
            .setRequired(true)
            .addChoices(
                { name: 'daily (24h)', value: 'daily' },
                { name: 'weekly (7d)', value: 'weekly' },
            ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const guildDiscordId = interaction.guildId;
    if (!guildDiscordId) {
        await interaction.editReply('Use inside a Discord server.');
        return;
    }

    const guild = await prisma.guild.findUnique({
        where: { discordId: guildDiscordId },
        include: { alertChannels: true },
    });
    if (!guild) {
        await interaction.editReply('Guild not onboarded (/setup).');
        return;
    }

    const period = interaction.options.getString('period', true) as 'daily' | 'weekly';
    const horizon = new Date(Date.now() - (period === 'daily' ? 24 : 168) * 3600 * 1000);

    const channelIds = [
        ...new Set(
            [
                ...guild.alertChannels.map(c => c.discordChannelId),
                ...(
                    await prisma.trackedCollection.findMany({
                        where: { guildId: guild.id },
                        select: {
                            alertChannelId: true,
                            delistChannelId: true,
                            hotMintChannelId: true,
                        },
                    })
                ).flatMap(r => [r.alertChannelId, r.delistChannelId, r.hotMintChannelId]),
            ].filter(Boolean) as string[],
        ),
    ];

    if (!channelIds.length) {
        await interaction.editReply(`No alert channels wired yet for this guild.\n${STANDARD_MARKET_DISCLAIMER}`);
        return;
    }

    const deliveries = await prisma.alertDeliveryLog.findMany({
        where: {
            channelId: { in: channelIds },
            status: 'delivered',
            createdAt: { gte: horizon },
        },
        select: { alertType: true },
    });

    const counts = deliveries.reduce<Map<string, number>>((acc, d) => {
        acc.set(d.alertType, (acc.get(d.alertType) ?? 0) + 1);
        return acc;
    }, new Map());

    const ranking = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const body =
        ranking.length > 0
            ? ranking
                  .slice(0, 12)
                  .map(([t, c]) => `• ${t}: **${c}**`)
                  .join('\n')
            : 'No delivered alerts logged in Postgres for routed channels yet.';

    const limits =
        '*Rankings omit deal sizes and wallet identities because those fields are not stored in AlertDeliveryLog — treat this as directional volume only.*';

    const embed = new EmbedBuilder()
        .setTitle(`${period === 'daily' ? 'Daily' : 'Weekly'} recap (counts)`)
        .setColor(0x94a3b8)
        .setDescription([body, '', limits].join('\n'))
        .setFooter({ text: STANDARD_MARKET_DISCLAIMER });

    await interaction.editReply({ embeds: [embed] });
}
