import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { ethers } from 'ethers';
import { redisConnection } from '@superbot/queue';
import { prisma } from '@superbot/database';
import { CollectionNameResolver, NFTMetadataClient, createRpcPoolFromEnv } from '@superbot/analytics';
import { explainOpportunitySpike } from '@superbot/intelligence';
import { appendWhyItMattersEmbed, STANDARD_MARKET_DISCLAIMER } from '../embeds';

const rpcPool = createRpcPoolFromEnv();
const nftMetadata = new NFTMetadataClient({ redis: redisConnection });
const collectionNames = new CollectionNameResolver({
    redis: redisConnection,
    nftMetadata,
    rpcPool: rpcPool && rpcPool.httpsUrls.length > 0 ? rpcPool : null,
});

export const data = new SlashCommandBuilder()
    .setName('opportunity')
    .setDescription('Detailed cached momentum readout for one collection (Redis snapshot)')
    .addSubcommand(sc =>
        sc
            .setName('collection')
            .setDescription('Contract address or known collection name')
            .addStringOption(o =>
                o.setName('address_or_name').setDescription('0x address or label').setRequired(true),
            ),
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    if (sub !== 'collection') return;

    await interaction.deferReply({ ephemeral: true });

    const guildDiscordId = interaction.guildId;
    if (!guildDiscordId) {
        await interaction.editReply('Use this inside a Discord server.');
        return;
    }
    const guildRow = await prisma.guild.findUnique({ where: { discordId: guildDiscordId } });
    if (!guildRow) {
        await interaction.editReply('Run /setup once for this server.');
        return;
    }

    const raw = interaction.options.getString('address_or_name', true).trim();
    let contract: string;
    if (!ethers.isAddress(raw)) {
        const row = await prisma.trackedCollection.findFirst({
            where: {
                guildId: guildRow.id,
                chain: 'ethereum',
                name: { contains: raw, mode: 'insensitive' },
            },
            select: { contractAddress: true },
            orderBy: { updatedAt: 'desc' },
        });
        if (!row) {
            await interaction.editReply(
                'Could not match that name to a tracked collection contract. Pass a 0x address or a name that matches a tracked collection.',
            );
            return;
        }
        contract = row.contractAddress.toLowerCase();
    } else {
        contract = ethers.getAddress(raw).toLowerCase();
    }

    let snap: Record<string, unknown> | null = null;
    try {
        const s = await redisConnection.get(`opportunity:snapshot:ethereum:${contract}`);
        if (s) snap = JSON.parse(s) as Record<string, unknown>;
    } catch {
        snap = null;
    }

    if (!snap || typeof snap.score !== 'number') {
        await interaction.editReply(
            `No cached snapshot for \`${contract}\`. The opportunity monitor writes snapshots when it evaluates tracked or recently-active collections.`,
        );
        return;
    }

    const { name: label } = await collectionNames.resolve(contract, {});
    const score = Number(snap.score) || 0;
    const confidence = String(snap.confidence || 'medium');
    const risk = String(snap.riskLabel || 'Medium risk');
    const signal = String(snap.signalLabel || 'Early watch signal');
    const buyers = Number(snap.uniqueBuyers15m ?? 0);
    const trades = Number(snap.trades15m ?? 0);
    const vol = Number(snap.volume15m ?? 0);
    const evidenceLines = [
        `Cached score ${score} (leaderboard-aligned).`,
        `15m trades: ${trades}; unique buyers: ${buyers}.`,
        `15m volume ≈ ${vol.toFixed(4)} ETH (normalized cache).`,
        snap.gates && typeof snap.gates === 'object'
            ? `Gate flags: ${JSON.stringify(snap.gates).slice(0, 200)}`
            : 'Gate flags unavailable in this snapshot.',
    ];

    const cx = explainOpportunitySpike({
        collectionLabel: label,
        windowLabel: '15–60 minutes (rolling, cached)',
        score,
        signalLabel: signal,
        confidenceLabel: confidence,
        riskLabel: risk,
        evidenceLines,
        limitations: ['Snapshot may be up to ~10 minutes stale versus live order books.'],
    });

    const embed = new EmbedBuilder()
        .setTitle('Collection opportunity (cached)')
        .setDescription(`**${label}** · \`${contract}\``)
        .addFields(
            { name: 'Opportunity score', value: String(score), inline: true },
            { name: 'Signal', value: signal, inline: true },
            { name: 'Confidence', value: confidence, inline: true },
        )
        .setFooter({ text: STANDARD_MARKET_DISCLAIMER });

    appendWhyItMattersEmbed(embed, cx, null);

    await interaction.editReply({ embeds: [embed] });
}
