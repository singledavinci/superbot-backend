import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

const FOOTER =
    'Not financial advice. Mint success not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder().setName('mint-jobs').setDescription('List recent mint jobs for this server');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }
    const res = await mintEnginePost('/jobs/list', { guildDiscordId: gid, userDiscordId: interaction.user.id });
    const j = (await res.json()) as { jobs?: Array<{ id: string; status: string; createdAt: string }> };
    const lines = (j.jobs ?? []).slice(0, 15).map(x => `• ${x.id.slice(0, 8)}… **${x.status}**`);
    const embed = new EmbedBuilder()
        .setTitle('Mint jobs')
        .setDescription(lines.length ? lines.join('\n') : 'No jobs yet.')
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
