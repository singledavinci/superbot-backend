import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '@superbot/database';

export const data = new SlashCommandBuilder()
    .setName('smart-money')
    .setDescription('Show a leaderboard of the most profitable wallets being tracked.')
    .addStringOption(opt => 
        opt.setName('chain')
            .setDescription('Filter by chain')
            .addChoices(
                { name: 'Ethereum', value: 'ethereum' },
                { name: 'Polygon', value: 'polygon' },
                { name: 'Base', value: 'base' }
            )
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    try {
        // Fetch top tracked wallets with highest win rates / flips
        // In a real prod environment, we would query ClickHouse for real-time PnL
        const topWallets = await prisma.trackedWallet.findMany({
            where: {
                winRate: { not: null },
                totalFlips: { gt: 5 }
            },
            orderBy: [
                { winRate: 'desc' },
                { totalFlips: 'desc' }
            ],
            take: 10
        });

        if (topWallets.length === 0) {
            return interaction.editReply('📊 No smart money data available yet. Start tracking wallets with `/track-wallet`!');
        }

        const embed = new EmbedBuilder()
            .setTitle('🧠 Smart Money Leaderboard')
            .setDescription('Top performing wallets across all tracked servers.')
            .setColor(0x5865F2)
            .setTimestamp();

        topWallets.forEach((w, i) => {
            const winPct = ((w.winRate || 0) * 100).toFixed(0);
            embed.addFields({
                name: `${i + 1}. ${w.label || 'Anonymous Whale'}`,
                value: `\`${w.address}\`\n📈 Win Rate: **${winPct}%** | 🔄 Flips: **${w.totalFlips}**`,
                inline: false
            });
        });

        await interaction.editReply({ embeds: [embed] });

    } catch (err: any) {
        console.error('[/smart-money] Error:', err);
        await interaction.editReply('❌ Failed to fetch leaderboard.');
    }
}
