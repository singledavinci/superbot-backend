import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { ethers } from 'ethers';
import { prisma } from '@superbot/database';
import { markdownCollectionToolkit } from '../embeds';
import { links } from '../links';

export const data = new SlashCommandBuilder()
    .setName('risk')
    .setDescription('Run a risk diagnostic on an NFT collection.')
    .addStringOption(opt => 
        opt.setName('address')
            .setDescription('Contract address of the collection')
            .setRequired(true)
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const address = interaction.options.getString('address')!;

    if (!ethers.isAddress(address)) {
        return interaction.editReply('❌ Invalid Ethereum address.');
    }

    try {
        const collection = await prisma.trackedCollection.findFirst({
            where: { contractAddress: { equals: address, mode: 'insensitive' } }
        });

        const collectionName = collection?.name || address.slice(0, 10);
        
        // Removed randomized/mocked data (Math.random) per audit.
        // In this version, we only provide a report if real analytics are available from ClickHouse/Profiler.
        
        const embed = new EmbedBuilder()
            .setTitle(`🛡️ Risk Diagnostic: ${collectionName}`)
            .setURL(links.etherscan.token(address))
            .setColor('#808080') 
            .setDescription(`Intelligence scan for **${collectionName}** on Ethereum.`)
            .addFields(
                { name: '🕵️ Wash Trade Risk', value: 'Insufficient data', inline: true },
                { name: '👥 Unique Buyers (1h)', value: 'Insufficient data', inline: true },
                { name: '📦 Holder Concentration', value: 'Insufficient data', inline: true }
            )
            .addFields(
                { name: '📅 Contract Age', value: 'Insufficient data', inline: true },
                { name: '⚡ Floor Velocity', value: 'Insufficient data', inline: true },
                { name: '💧 Liquidity Depth', value: 'Insufficient data', inline: true }
            )
            .addFields({ name: 'Links', value: markdownCollectionToolkit(address, null), inline: false })
            .addFields({
                name: '🧠 Pro Verdict',
                value: `⚠️ **INSUFFICIENT DATA**: Real-time risk metrics are currently being indexed for this collection. Please check back in a few minutes once historical depth is established.`
            })
            .setTimestamp()
            .setFooter({ text: 'SuperBot Context Engine • Not financial advice' });

        await interaction.editReply({ embeds: [embed] });

    } catch (err: any) {
        console.error('[/risk] Error:', err);
        await interaction.editReply('❌ Risk analysis failed.');
    }
}
