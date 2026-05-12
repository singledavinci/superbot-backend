import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';
import { isTrustMintAdmin } from '../lib/mintAdmin';

const FOOTER =
    'Execution tools are automation-based and not financial advice. Mint success is not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-revoke-wallet')
    .setDescription('Admin: revoke active mainnet execution approval for a wallet')
    .addUserOption(o => o.setName('user').setDescription('Discord user who owns the mint wallet').setRequired(true))
    .addStringOption(o => o.setName('wallet').setDescription('Mint wallet address (0x…)').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }
    if (!isTrustMintAdmin(interaction)) {
        await interaction.editReply('Administrator permission and mint admin allow-list (if configured) required.');
        return;
    }
    const target = interaction.options.getUser('user', true);
    const wallet = interaction.options.getString('wallet', true).toLowerCase();

    const res = await mintEnginePost('/mainnet-approval/revoke', {
        adminDiscordId: interaction.user.id,
        guildDiscordId: gid,
        userDiscordId: target.id,
        walletAddress: wallet,
    });
    const j = (await res.json()) as Record<string, unknown>;
    const embed = new EmbedBuilder()
        .setTitle('Mainnet approval revoke')
        .setDescription(res.ok ? `Revoked rows: **${String(j.revoked ?? '—')}**` : JSON.stringify(j).slice(0, 3500))
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
