import { PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';

export function isGuildAdministrator(interaction: ChatInputCommandInteraction): boolean {
    if (!interaction.memberPermissions) return false;
    return interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
}

/** Guild admin; if MINT_ADMIN_DISCORD_IDS is set, user must also be in that list. */
export function isTrustMintAdmin(interaction: ChatInputCommandInteraction): boolean {
    if (!isGuildAdministrator(interaction)) return false;
    const raw = process.env.MINT_ADMIN_DISCORD_IDS || '';
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return true;
    return ids.includes(interaction.user.id);
}
