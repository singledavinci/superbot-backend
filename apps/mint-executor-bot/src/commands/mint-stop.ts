import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

const FOOTER =
    'Not financial advice. Mint success not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-stop')
    .setDescription('Cancel a queued/scheduled mint job before broadcast')
    .addStringOption(o => o.setName('job_id').setDescription('Mint job UUID').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const jobId = interaction.options.getString('job_id', true);
    const res = await mintEnginePost('/jobs/cancel', { jobId });
    const j = await res.json();
    const embed = new EmbedBuilder()
        .setTitle('Mint stop')
        .setDescription(JSON.stringify(j, null, 2).slice(0, 3800))
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
