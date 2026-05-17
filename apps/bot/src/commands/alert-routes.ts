import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    PermissionFlagsBits,
    EmbedBuilder,
} from 'discord.js';
import { prisma } from '@superbot/database';
import { ALERT_ROUTE_PREFERENCE, resolveAlertRoute } from '@superbot/types';
import { BRAND_ACCENT } from '../lib/embedTheme';

const CHANNEL_LABELS: Record<string, string> = {
    MINT_RADAR: 'Mint radar',
    HOT_MINT: 'Hot mints',
    WHALE_BUY: 'Whale buys',
    WHALE_SALE: 'Whale sales',
    WHALE_MINT: 'Whale mints',
    WALLET_ACTION_BATCH: 'Wallet batches',
    CLUSTER_BUY: 'Cluster buys',
    SWEEP: 'Sweeps',
    MASS_LISTING: 'Listing surges',
    MASS_DELIST: 'Delist surges',
    FLOOR_IMPACT_FOLLOWUP: 'Floor follow-ups',
    FLOOR_DROP: 'Floor drops',
    FLOOR_RISE: 'Floor rises',
    OPPORTUNITY_SPIKE: 'Opportunity spikes',
};

export const data = new SlashCommandBuilder()
    .setName('alert-routes')
    .setDescription('Show where each alert type is posted and which role is pinged.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
        await interaction.editReply('This command only works inside a server.');
        return;
    }

    const guild = await prisma.guild.findUnique({
        where: { discordId: guildId },
        include: { alertChannels: { orderBy: { alertType: 'asc' } } },
    });

    if (!guild) {
        await interaction.editReply(
            'This server is not onboarded yet. Run `/setup` or use the dashboard, then run `setup-alert-channels.js` for the full SuperBot Alerts layout.',
        );
        return;
    }

    const channels = guild.alertChannels;
    const byType = new Map(channels.map(r => [r.alertType, r]));
    const lines: string[] = [];

    for (const alertType of Object.keys(ALERT_ROUTE_PREFERENCE)) {
        const label = CHANNEL_LABELS[alertType] ?? alertType;
        const effective = resolveAlertRoute(channels, alertType);
        const direct = byType.get(alertType);

        if (!effective.channelId) {
            lines.push(`**${label}**\n- _Not configured_`);
            continue;
        }

        const ch = `<#${effective.channelId}>`;
        const role = effective.mentionRoleId ? `<@&${effective.mentionRoleId}>` : '_No ping role_';
        const viaFallback =
            direct?.discordChannelId && direct.discordChannelId !== effective.channelId
                ? ' _(effective route uses fallback)_'
                : !direct?.discordChannelId
                  ? ' _(via fallback type)_'
                  : '';
        lines.push(`**${label}**${viaFallback}\n- Channel ${ch} | Ping ${role}`);
    }

    const embed = new EmbedBuilder()
        .setColor(BRAND_ACCENT)
        .setTitle('SuperBot alert routing')
        .setDescription(
            'Each alert type posts to its dedicated channel under **SuperBot Alerts**. Members opt into pings in `#alert-roles`.\n\n' +
                lines.join('\n\n').slice(0, 3900),
        )
        .setFooter({
            text: 'Per-collection channel overrides are ignored for specialized alerts.',
        })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}