import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';
import { isTrustMintAdmin } from '../lib/mintAdmin';

const FOOTER =
    'Execution tools are automation-based and not financial advice. Mint success is not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-emergency-stop')
    .setDescription('Admin: activate DB-backed mint emergency stop (blocks sign/broadcast)');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!isTrustMintAdmin(interaction)) {
        await interaction.editReply('Administrator permission and mint admin allow-list (if configured) required.');
        return;
    }
    const res = await mintEnginePost('/runtime/emergency-stop', {
        adminDiscordId: interaction.user.id,
    });
    const j = (await res.json()) as Record<string, unknown>;
    const embed = new EmbedBuilder()
        .setTitle('Mint emergency stop')
        .setDescription(res.ok ? `Effective: **${String(j.emergencyStopEffective ?? '—')}**` : `HTTP ${res.status}`)
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
