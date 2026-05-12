import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

export const data = new SlashCommandBuilder()
    .setName('mint-confirm-mainnet')
    .setDescription('Record operator manual confirmation for a mainnet live MintJob (mint admins only)')
    .addStringOption(o => o.setName('job_id').setDescription('MintJob UUID').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
        await interaction.editReply('Use this command in a server.');
        return;
    }

    const jobId = interaction.options.getString('job_id', true).trim();
    const body = {
        adminDiscordId: interaction.user.id,
        userDiscordId: interaction.user.id,
        jobId,
    };

    let res: Response;
    try {
        res = await mintEnginePost('/jobs/confirm-mainnet', body);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        await interaction.editReply(`Mint engine request failed: ${msg.slice(0, 500)}`);
        return;
    }

    const text = await res.text();
    if (!res.ok) {
        await interaction.editReply(`Mint engine HTTP ${res.status}: ${text.slice(0, 500)}`);
        return;
    }

    try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const id = j.jobId ?? jobId;
        await interaction.editReply(`Mainnet confirmation recorded for job **${String(id)}**.`);
    } catch {
        await interaction.editReply('Mainnet confirmation recorded.');
    }
}
