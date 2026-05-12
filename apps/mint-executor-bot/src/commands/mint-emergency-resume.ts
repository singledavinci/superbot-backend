import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';
import { isTrustMintAdmin } from '../lib/mintAdmin';

const FOOTER =
    'Execution tools are automation-based and not financial advice. Mint success is not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-emergency-resume')
    .setDescription('Admin: clear DB-backed mint emergency stop (env stop may still apply)');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!isTrustMintAdmin(interaction)) {
        await interaction.editReply('Administrator permission and mint admin allow-list (if configured) required.');
        return;
    }
    const res = await mintEnginePost('/runtime/emergency-resume', {
        adminDiscordId: interaction.user.id,
    });
    const j = (await res.json()) as Record<string, unknown>;
    const embed = new EmbedBuilder()
        .setTitle('Mint emergency resume')
        .setDescription(res.ok ? `Effective emergency stop: **${String(j.emergencyStopEffective ?? '—')}**` : `HTTP ${res.status}`)
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
