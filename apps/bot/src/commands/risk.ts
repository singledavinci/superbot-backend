import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';
import { redisConnection } from '@superbot/queue';
import { markdownCollectionToolkit } from '../embeds';

export const data = new SlashCommandBuilder()
    .setName('risk')
    .setDescription('Show verified collection facts SuperBot currently has wired')
    .addStringOption(opt =>
        opt
            .setName('address')
            .setDescription('Contract address of the collection')
            .setRequired(true),
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const address = interaction.options.getString('address', true).trim();

    if (!ethers.isAddress(address)) {
        return interaction.editReply('❌ Invalid Ethereum address.');
    }

    const normalized = ethers.getAddress(address).toLowerCase();

    try {
        const collection = await prisma.trackedCollection.findFirst({
            where: { contractAddress: { equals: normalized, mode: 'insensitive' } },
            include: { guild: { select: { name: true } } },
        });

        let floorSnippet = 'Insufficient verified data for a curated floor.';
        try {
            const raw = await redisConnection.get(`floor:ethereum:${normalized}`);
            if (raw) {
                const j = JSON.parse(raw) as { priceNative?: number; currency?: string; ts?: number };
                if (typeof j.priceNative === 'number' && j.priceNative > 0) {
                    const cur = j.currency || 'ETH';
                    floorSnippet = `Redis floor cache: ~${j.priceNative.toFixed(4)} ${cur}.`;
                    if (j.ts)
                        floorSnippet += ` Cached at Unix ms ${j.ts}.`;
                }
            }
        } catch {
            /* ignore */
        }

        const guildLabel = collection?.guild.name ?? 'Untracked guild row';
        const name = collection?.name ?? `${normalized.slice(0, 10)}…`;

        const summary = [
            '**Insufficient verified data for a full risk report.**',
            'Holder concentration, liquidity, wash probability, profitability, contract vintage, royalties stress — **not computed** unless a future data feed supplies them explicitly.',
            '',
            '**Verified facts available to SuperBot right now:**',
            collection
                ? `• Postgres tracking record: ${name}`
                : '• Postgres: no tracked collection row with this normalized address.',
            collection ? `• Linked guild label: ${guildLabel}` : '',
            `• Cached floor excerpt: ${floorSnippet}`,
            collection
                ? `• Alert wiring: whale channel discord id ${collection.alertChannelId ?? 'unset'} · delists ${collection.delistChannelId ?? 'follows whale'} · rise/drop pct ${collection.floorRiseAlertPct ?? 'unset'} / ${collection.floorAlertPct ?? 'unset'}.`
                : '',
            '',
            'Not financial advice. Signals are informational and may be incomplete or delayed.',
        ]
            .filter(Boolean)
            .join('\n');

        await interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`Risk facts (verified only): ${name}`)
                    .setURL(`https://etherscan.io/token/${normalized}`)
                    .setColor('#94a3b8')
                    .setDescription(summary)
                    .addFields({
                        name: 'Links',
                        value: markdownCollectionToolkit(normalized, null),
                        inline: false,
                    })
                    .setFooter({ text: 'SuperBot risk facts • informational only' }),
            ],
        });
    } catch (err) {
        console.error('[/risk] Error:', err);
        await interaction.editReply('❌ Risk summary failed.');
    }
}
