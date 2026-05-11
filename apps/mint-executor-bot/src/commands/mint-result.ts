import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';
import { buildMintJobResultEmbed } from '../lib/mintEmbeds';

export const data = new SlashCommandBuilder()
    .setName('mint-result')
    .setDescription('Show mint job lifecycle and latest simulation')
    .addStringOption(o => o.setName('job_id').setDescription('Mint job UUID').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const jobId = interaction.options.getString('job_id', true);
    const res = await mintEnginePost('/jobs/result', { jobId });
    if (!res.ok) {
        const t = await res.text();
        await interaction.editReply({ content: `Mint engine HTTP ${res.status}: ${t.slice(0, 500)}` });
        return;
    }
    const j = (await res.json()) as Record<string, unknown>;
    if (j.error) {
        await interaction.editReply({ content: `Error: ${String(j.error)}` });
        return;
    }
    const embed = buildMintJobResultEmbed(j);
    await interaction.editReply({ embeds: [embed] });
}
