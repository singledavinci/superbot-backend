import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

export const data = new SlashCommandBuilder()
    .setName('mint-revoke')
    .setDescription('Revoke active mainnet approval for a wallet (mint admins only)')
    .addStringOption(o => o.setName('wallet').setDescription('Wallet address (0x…, chain 1)').setRequired(true))
    .addUserOption(o =>
        o.setName('target_user').setDescription('Discord user whose approval to revoke (defaults to you)').setRequired(false),
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }

    const walletAddress = interaction.options.getString('wallet', true).trim().toLowerCase();
    const targetUser = interaction.options.getUser('target_user');
    const userDiscordId = targetUser?.id ?? interaction.user.id;

    const body = {
        adminDiscordId: interaction.user.id,
        guildDiscordId: gid,
        userDiscordId,
        walletAddress,
    };

    let res: Response;
    try {
        res = await mintEnginePost('/mainnet-approval/revoke', body);
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
        const n = j.revoked;
        await interaction.editReply(`Mainnet approval revoke processed (revoked approvals: **${String(n ?? '?')}**).`);
    } catch {
        await interaction.editReply('Mainnet approval **revoke** acknowledged.');
    }
}
