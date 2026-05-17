import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { buildGuideReply } from '../lib/componentInteractions';

export const data = new SlashCommandBuilder()
    .setName('guide')
    .setDescription('How SuperBot works — alerts, tracking, and commands.');

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply(buildGuideReply(0));
}