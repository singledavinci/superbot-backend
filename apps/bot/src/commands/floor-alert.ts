import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    PermissionFlagsBits,
} from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';
import { STANDARD_MARKET_DISCLAIMER } from '../embeds';

export const data = new SlashCommandBuilder()
    .setName('floor-alert')
    .setDescription('Tune floor-move alerts for a tracked collection (wraps tracked-collection thresholds)')
    .addSubcommand(sc =>
        sc
            .setName('set-drop-threshold')
            .setDescription('Alert when floor falls by ≥ this percentage')
            .addStringOption(o =>
                o.setName('contract').setDescription('Collection contract').setRequired(true),
            )
            .addNumberOption(o =>
                o.setName('percent').setDescription('Percent decline (positive number)').setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('set-rise-threshold')
            .setDescription('Alert when floor rises by ≥ this percentage')
            .addStringOption(o =>
                o.setName('contract').setDescription('Collection contract').setRequired(true),
            )
            .addNumberOption(o =>
                o.setName('percent').setDescription('Percent increase (positive number)').setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('clear')
            .setDescription('Disable floor-rise / floor-drop alerting for contract')
            .addStringOption(o =>
                o.setName('contract').setDescription('Collection contract').setRequired(true),
            ),
    )
    .addSubcommand(sc =>
        sc
            .setName('show')
            .setDescription('Show configured thresholds')
            .addStringOption(o =>
                o.setName('contract').setDescription('Collection contract').setRequired(true),
            ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    const guildDiscordId = interaction.guildId;
    if (!guildDiscordId) {
        await interaction.editReply('Use this inside a Discord server.');
        return;
    }

    const guild = await prisma.guild.findUnique({ where: { discordId: guildDiscordId } });
    if (!guild) {
        await interaction.editReply('Run /setup once so this guild exists in SuperBot.');
        return;
    }

    const raw = interaction.options.getString('contract', true).trim();
    if (!ethers.isAddress(raw)) {
        await interaction.editReply('Invalid contract.');
        return;
    }
    const contract = ethers.getAddress(raw).toLowerCase();

    const row = await prisma.trackedCollection.findFirst({
        where: {
            guildId: guild.id,
            contractAddress: { equals: contract, mode: 'insensitive' },
        },
    });

    if (!row) {
        await interaction.editReply(
            'Collection is not tracked in this guild. Use `/track-collection` first.',
        );
        return;
    }

    const foot = STANDARD_MARKET_DISCLAIMER;

    if (sub === 'show') {
        await interaction.editReply(
            `Floor drop alert at ≥ ${row.floorAlertPct ?? 'unset'}%\nFloor rise alert at ≥ ${row.floorRiseAlertPct ?? 'unset'}%\n${foot}`,
        );
        return;
    }

    if (sub === 'clear') {
        await prisma.trackedCollection.update({
            where: { id: row.id },
            data: { floorAlertPct: null, floorRiseAlertPct: null },
        });
        await interaction.editReply(`Cleared thresholds for ${row.name}. (${foot})`);
        return;
    }

    const pctRaw = interaction.options.getNumber('percent', true);
    if (!(pctRaw > 0) || pctRaw > 100) {
        await interaction.editReply('Percent must be between 0 and 100.');
        return;
    }

    if (sub === 'set-drop-threshold') {
        await prisma.trackedCollection.update({
            where: { id: row.id },
            data: { floorAlertPct: pctRaw },
        });
        await interaction.editReply(`${row.name}: drop alerts when floor falls ≥ ${pctRaw}%. (${foot})`);
        return;
    }

    if (sub === 'set-rise-threshold') {
        await prisma.trackedCollection.update({
            where: { id: row.id },
            data: { floorRiseAlertPct: pctRaw },
        });
        await interaction.editReply(`${row.name}: rise alerts when floor climbs ≥ ${pctRaw}%. (${foot})`);
    }
}
