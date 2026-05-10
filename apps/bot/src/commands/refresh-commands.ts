import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { refreshGuildSlashCommands } from '../command-sync-context';

export const data = new SlashCommandBuilder()
    .setName('refresh-commands')
    .setDescription('Re-register SuperBot slash commands in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
        await interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const result = await refreshGuildSlashCommands(interaction.guildId);
    const who = interaction.user.tag;
    const gid = interaction.guildId;

    if (result.ok) {
        const n = result.commandCount ?? 0;
        console.log(`[Bot] /refresh-commands by ${who} in guild ${gid} — success (${n} commands)`);
        await interaction.editReply(
            `Registered **${n}** slash command(s) for this server. If they do not appear immediately, wait a minute and type \`/\` again.`
        );
    } else {
        console.warn(
            `[Bot] /refresh-commands by ${who} in guild ${gid} — failed status=${result.status ?? '?'} ${result.message ?? ''}`
        );
        const hint =
            result.status === 403 || result.status === 401
                ? ' Re-invite the bot with the **applications.commands** scope (see the invite URL in bot startup logs).'
                : '';
        await interaction.editReply(
            `Could not register commands (HTTP ${result.status ?? '?'}).${hint} Details: ${result.message ?? 'unknown error'}`
        );
    }
}
