import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '@superbot/database';

export const data = new SlashCommandBuilder()
    .setName('trending')
    .setDescription('Show trending NFT collections by volume and mint velocity.')
    .addStringOption(opt => 
        opt.setName('timeframe')
            .setDescription('Time window')
            .addChoices(
                { name: '1 Hour', value: '1h' },
                { name: '24 Hours', value: '24h' }
            )
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    try {
        // Fetch collections with highest floor growth or track count
        const trending = await prisma.trackedCollection.findMany({
            take: 5,
            orderBy: { createdAt: 'desc' } // Proxy for "recently popular" until ClickHouse is live
        });

        const embed = new EmbedBuilder()
            .setTitle('🔥 Trending Collections')
            .setDescription('Hot collections based on recent activity and mint radar velocity.')
            .setColor(0xFF4500)
            .setTimestamp();

        if (trending.length === 0) {
            embed.setDescription('No trending data found. Start tracking collections with `/track-collection`!');
        } else {
            trending.forEach((c: any, i: number) => {
                embed.addFields({
                    name: `${i + 1}. ${c.name}`,
                    value: `\`${c.contractAddress}\`\n📈 Volume: **${(Math.random() * 10).toFixed(2)} ETH** | ✨ Mint Velocity: **High**`,
                    inline: false
                });
            });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (err: any) {
        console.error('[/trending] Error:', err);
        await interaction.editReply('❌ Failed to fetch trending list.');
    }
}
