import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

const FOOTER =
    'Not financial advice. Mint success not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-settings')
    .setDescription('Admin: patch guild mint settings JSON (engine reads via future hooks)')
    .addStringOption(o => o.setName('patch_json').setDescription('JSON object merged into guild.settings.mintEngine').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }
    const raw = interaction.options.getString('patch_json', true);
    let patch: object;
    try {
        patch = JSON.parse(raw) as object;
    } catch {
        await interaction.editReply('Invalid JSON.');
        return;
    }
    const res = await mintEnginePost('/settings/guild', { guildDiscordId: gid, patch });
    const j = await res.json();
    const embed = new EmbedBuilder()
        .setTitle('Mint settings')
        .setDescription(JSON.stringify(j, null, 2).slice(0, 3800))
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
