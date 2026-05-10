import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';

export const data = new SlashCommandBuilder()
    .setName('track-collection')
    .setDescription('Track an NFT collection and route sale/listing alerts.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
        opt.setName('contract')
            .setDescription('Collection contract address (0x...)')
            .setRequired(true)
    )
    .addStringOption(opt =>
        opt.setName('name')
            .setDescription('Collection name (e.g. "Pudgy Penguins")')
            .setRequired(true)
    )
    .addNumberOption(opt =>
        opt.setName('floor-alert')
            .setDescription('Alert when floor drops by this % (e.g. 10 = 10%)')
            .setRequired(false)
    )
    .addNumberOption(opt =>
        opt.setName('floor-rise-pct')
            .setDescription('Alert when floor rises by this % (pump signal)')
            .setRequired(false)
    )
    .addNumberOption(opt =>
        opt.setName('sweep-threshold')
            .setDescription('Min total ETH spent in a sweep tx to alert (guild override)')
            .setRequired(false)
    )
    .addIntegerOption(opt =>
        opt.setName('mass-listing-threshold')
            .setDescription('Min listing events in the surge window to alert')
            .setRequired(false)
    )
    .addStringOption(opt =>
        opt.setName('channel-id')
            .setDescription('Discord channel ID to route alerts to')
            .setRequired(false)
    )
    .addRoleOption(opt =>
        opt.setName('mention-role')
            .setDescription('Role to ping for alerts from this collection')
            .setRequired(false)
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const contract    = interaction.options.getString('contract', true).toLowerCase().trim();
    const name        = interaction.options.getString('name', true).substring(0, 32);
    const floorAlert  = interaction.options.getNumber('floor-alert') ?? null;
    const floorRisePct = interaction.options.getNumber('floor-rise-pct') ?? null;
    const sweepThreshold = interaction.options.getNumber('sweep-threshold') ?? null;
    const massListingThreshold = interaction.options.getInteger('mass-listing-threshold') ?? null;
    const channelId   = interaction.options.getString('channel-id') ?? null;
    const role        = interaction.options.getRole('mention-role');
    const guildId     = interaction.guildId!;

    if (!ethers.isAddress(contract)) {
        return interaction.editReply('❌ Invalid contract address. Please provide a valid `0x...` address.');
    }

    try {
        const guild = await prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild) {
            return interaction.editReply('❌ Server not set up yet. Run `/setup` first.');
        }

        // Resolve target channel — fall back to first alert channel
        let targetChannelId = channelId;
        if (!targetChannelId) {
            const defaultChannel = await prisma.alertChannel.findFirst({ where: { guildId: guild.id } });
            targetChannelId = defaultChannel?.discordChannelId ?? null;
        }

        if (!targetChannelId) {
            return interaction.editReply('❌ No alert channel found. Run `/setup` or provide a `channel-id`.');
        }

        const collection = await prisma.trackedCollection.upsert({
            where:  { contractAddress_guildId: { contractAddress: contract, guildId: guild.id } },
            create: {
                guildId: guild.id,
                contractAddress: contract,
                name,
                floorAlertPct: floorAlert,
                floorRiseAlertPct: floorRisePct,
                sweepThresholdNative: sweepThreshold,
                massListingThreshold: massListingThreshold ?? undefined,
                alertChannelId: targetChannelId,
                mentionRoleId: role?.id,
            },
            update: {
                name,
                floorAlertPct: floorAlert,
                floorRiseAlertPct: floorRisePct,
                sweepThresholdNative: sweepThreshold,
                massListingThreshold: massListingThreshold ?? undefined,
                alertChannelId: targetChannelId,
                mentionRoleId: role?.id,
            },
        });

        const embed = new EmbedBuilder()
            .setColor('#a855f7')
            .setTitle('🖼️ Collection Now Tracked')
            .addFields(
                { name: 'Collection', value: name,              inline: true },
                { name: 'Contract',   value: `\`${contract.slice(0, 12)}...\``, inline: true },
                { name: 'Floor drop %', value: floorAlert != null ? `${floorAlert}%` : '—', inline: true },
                { name: 'Floor rise %', value: floorRisePct != null ? `${floorRisePct}%` : '—', inline: true },
                { name: 'Sweep min ΣETH', value: sweepThreshold != null ? String(sweepThreshold) : 'default', inline: true },
                { name: 'Mass listings', value: massListingThreshold != null ? String(massListingThreshold) : 'default', inline: true },
                { name: 'Alerts →',   value: `<#${targetChannelId}>`, inline: true },
                { name: 'Ping Role', value: role ? `<@&${role.id}>` : '—', inline: true }
            )
            .setFooter({ text: 'SuperBot Intelligence • Not financial advice' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (err: any) {
        console.error('[/track-collection] Error:', err);
        await interaction.editReply(`❌ Error: ${err.message ?? 'Unknown error'}`);
    }
}
