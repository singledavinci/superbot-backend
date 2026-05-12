import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

export const data = new SlashCommandBuilder()
    .setName('mint-emergency-resume')
    .setDescription('Clear mint-engine runtime emergency stop (mint admins only)');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
        await interaction.editReply('Use this command in a server.');
        return;
    }

    const adminDiscordId = interaction.user.id;
    const body = { adminDiscordId, userDiscordId: adminDiscordId };

    let res: Response;
    try {
        res = await mintEnginePost('/runtime/emergency-resume', body);
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
        const eff = j.emergencyStopEffective === true ? '**on**' : '**off**';
        await interaction.editReply(`Runtime emergency stop cleared (effective emergency: ${eff}).`);
    } catch {
        await interaction.editReply(`Unexpected response: ${text.slice(0, 400)}`);
    }
}
