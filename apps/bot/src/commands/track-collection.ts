import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';
import { redisConnection } from '@superbot/queue';
import {
    NFTMetadataClient,
    CollectionNameResolver,
    createRpcPoolFromEnv,
    isPlaceholderCollectionName,
} from '@superbot/analytics';

let trackCollectionResolver: CollectionNameResolver | null = null;
function resolverForCommands(): CollectionNameResolver {
    if (!trackCollectionResolver) {
        const pool = createRpcPoolFromEnv();
        trackCollectionResolver = new CollectionNameResolver({
            redis: redisConnection,
            nftMetadata: new NFTMetadataClient({ redis: redisConnection }),
            rpcPool: pool && pool.httpsUrls.length > 0 ? pool : null,
        });
    }
    return trackCollectionResolver;
}

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
    )
    .addBooleanOption(opt =>
        opt
            .setName('hot-mint-enabled')
            .setDescription('Enable hot-mint velocity alerts for this collection')
            .setRequired(false)
    )
    .addBooleanOption(opt =>
        opt
            .setName('delist-enabled')
            .setDescription('Enable mass-delist surge alerts for this collection')
            .setRequired(false)
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const contract    = interaction.options.getString('contract', true).toLowerCase().trim();
    const rawNameOpt  = interaction.options.getString('name', true).trim();
    const floorAlert  = interaction.options.getNumber('floor-alert') ?? null;
    const floorRisePct = interaction.options.getNumber('floor-rise-pct') ?? null;
    const sweepThreshold = interaction.options.getNumber('sweep-threshold') ?? null;
    const massListingThreshold = interaction.options.getInteger('mass-listing-threshold') ?? null;
    const channelId   = interaction.options.getString('channel-id') ?? null;
    const role        = interaction.options.getRole('mention-role');
    const hotMintEnabled = interaction.options.getBoolean('hot-mint-enabled');
    const delistEnabled = interaction.options.getBoolean('delist-enabled');
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

        const existingTc = await prisma.trackedCollection.findUnique({
            where: {
                contractAddress_guildId: { contractAddress: contract, guildId: guild.id },
            },
            select: { name: true },
        });

        const persistedName =
            !isPlaceholderCollectionName(rawNameOpt)
                ? rawNameOpt.slice(0, 128)
                : (
                      await resolverForCommands().resolve(contract, {
                          trackedName: existingTc?.name ?? undefined,
                      })
                  ).name.slice(0, 128);

        const collection = await prisma.trackedCollection.upsert({
            where:  { contractAddress_guildId: { contractAddress: contract, guildId: guild.id } },
            create: {
                guildId: guild.id,
                contractAddress: contract,
                name: persistedName,
                floorAlertPct: floorAlert,
                floorRiseAlertPct: floorRisePct,
                sweepThresholdNative: sweepThreshold,
                massListingThreshold: massListingThreshold ?? undefined,
                hotMintEnabled: hotMintEnabled ?? true,
                delistAlertEnabled: delistEnabled ?? true,
                alertChannelId: targetChannelId,
                mentionRoleId: role?.id,
            },
            update: {
                name: persistedName,
                floorAlertPct: floorAlert,
                floorRiseAlertPct: floorRisePct,
                sweepThresholdNative: sweepThreshold,
                massListingThreshold: massListingThreshold ?? undefined,
                ...(hotMintEnabled !== null ? { hotMintEnabled } : {}),
                ...(delistEnabled !== null ? { delistAlertEnabled: delistEnabled } : {}),
                alertChannelId: targetChannelId,
                mentionRoleId: role?.id,
            },
        });

        const embed = new EmbedBuilder()
            .setColor('#a855f7')
            .setTitle('🖼️ Collection Now Tracked')
            .addFields(
                { name: 'Collection', value: persistedName,              inline: true },
                { name: 'Contract',   value: `\`${contract.slice(0, 12)}...\``, inline: true },
                { name: 'Floor drop %', value: floorAlert != null ? `${floorAlert}%` : '—', inline: true },
                { name: 'Floor rise %', value: floorRisePct != null ? `${floorRisePct}%` : '—', inline: true },
                { name: 'Sweep min ΣETH', value: sweepThreshold != null ? String(sweepThreshold) : 'default', inline: true },
                { name: 'Mass listings', value: massListingThreshold != null ? String(massListingThreshold) : 'default', inline: true },
                { name: 'Hot mint', value: collection.hotMintEnabled ? 'on' : 'off', inline: true },
                { name: 'Delist alerts', value: collection.delistAlertEnabled ? 'on' : 'off', inline: true },
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
