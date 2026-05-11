import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    PermissionFlagsBits,
    ChannelType,
} from 'discord.js';
import { prisma } from '@superbot/database';

function mergeOpportunitySettings(
    prev: unknown,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    const base =
        prev && typeof prev === 'object' && prev !== null && !Array.isArray(prev)
            ? { ...(prev as Record<string, unknown>) }
            : {};
    const curOpp =
        base.opportunity && typeof base.opportunity === 'object' && base.opportunity !== null
            ? { ...(base.opportunity as Record<string, unknown>) }
            : {};
    return { ...base, opportunity: { ...curOpp, ...patch } };
}

export const data = new SlashCommandBuilder()
    .setName('opportunity-settings')
    .setDescription('Configure Collection Opportunity Monitor for this server (stored in guild settings JSON)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc.setName('enable').setDescription('Turn opportunity monitor routing on for this guild'))
    .addSubcommand(sc => sc.setName('disable').setDescription('Turn opportunity monitor routing off'))
    .addSubcommand(sc =>
        sc
            .setName('set-channel')
            .setDescription('Default Discord channel id for OPPORTUNITY_SPIKE (also set Alert Routing for best results)')
            .addStringOption(o =>
                o.setName('channel_id').setDescription('Numeric channel id').setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('set-threshold')
            .setDescription('Minimum score (overrides env default for this guild when set)')
            .addIntegerOption(o =>
                o.setName('score').setDescription('35–100').setMinValue(35).setMaxValue(100).setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('set-cooldown')
            .setDescription('Cooldown between opportunity alerts per collection+guild (ms)')
            .addIntegerOption(o =>
                o
                    .setName('ms')
                    .setDescription('600000–86400000')
                    .setMinValue(600_000)
                    .setMaxValue(86_400_000)
                    .setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('set-min-unique-buyers')
            .setDescription('Minimum unique buyers required for alerts (guild override)')
            .addIntegerOption(o =>
                o.setName('n').setDescription('2–30').setMinValue(2).setMaxValue(30).setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('set-role')
            .setDescription('Optional mention role id for opportunity alerts from this bot command path')
            .addStringOption(o =>
                o.setName('role_id').setDescription('Numeric role id or "clear"').setRequired(true),
            ),
    );

function parseSnowflake(s: string): string | null {
    const t = s.trim();
    if (!/^\d{17,22}$/.test(t)) return null;
    return t;
}

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this inside a Discord server.');
        return;
    }

    const guild = await prisma.guild.findUnique({ where: { discordId: gid } });
    if (!guild) {
        await interaction.editReply('Run /setup once so this guild exists in SuperBot.');
        return;
    }

    const sub = interaction.options.getSubcommand();
    let patch: Record<string, unknown> = {};

    if (sub === 'enable') patch = { enabled: true };
    else if (sub === 'disable') patch = { enabled: false };
    else if (sub === 'set-channel') {
        const id = parseSnowflake(interaction.options.getString('channel_id', true));
        if (!id) {
            await interaction.editReply('Invalid channel id.');
            return;
        }
        const ch = await interaction.client.channels.fetch(id).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) {
            await interaction.editReply('Channel not found or not a text channel in this server.');
            return;
        }
        patch = { channelDiscordId: id };
    } else if (sub === 'set-threshold') {
        patch = { scoreThreshold: interaction.options.getInteger('score', true) };
    } else if (sub === 'set-cooldown') {
        patch = { cooldownMs: interaction.options.getInteger('ms', true) };
    } else if (sub === 'set-min-unique-buyers') {
        patch = { minUniqueBuyers: interaction.options.getInteger('n', true) };
    } else if (sub === 'set-role') {
        const raw = interaction.options.getString('role_id', true).trim();
        if (raw.toLowerCase() === 'clear') patch = { mentionRoleId: null };
        else {
            const rid = parseSnowflake(raw);
            if (!rid) {
                await interaction.editReply('Invalid role id (use numeric id or "clear").');
                return;
            }
            patch = { mentionRoleId: rid };
        }
    }

    const next = mergeOpportunitySettings(guild.settings, patch);
    await prisma.guild.update({
        where: { id: guild.id },
        data: { settings: next as object },
    });

    await interaction.editReply(`Updated **opportunity** settings (${sub}).`);
}
