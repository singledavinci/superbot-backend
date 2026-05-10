import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('sniper')
    .setDescription('Deprecated placeholder — gated for safety');

export async function execute(interaction: ChatInputCommandInteraction) {
    if (process.env.SNIPER_FEATURE_ENABLED === 'true') {
        await interaction.reply({
            content:
                'Sniping features remain disabled pending a security review — even though SNIPER_FEATURE_ENABLED is true, no automated executor is wired in this deployment.',
            ephemeral: true,
        });
        return;
    }

    await interaction.reply({
        content:
            'Sniping is disabled. This bot will never ask for seed phrases or private keys.',
        ephemeral: true,
    });
}
