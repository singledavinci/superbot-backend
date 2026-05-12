import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';
import { isTrustMintAdmin } from '../lib/mintAdmin';

const FOOTER =
    'Execution tools are automation-based and not financial advice. Mint success is not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-approve-wallet')
    .setDescription('Admin: grant mainnet execution approval with gas and cost caps')
    .addUserOption(o => o.setName('user').setDescription('Discord user who owns the mint wallet').setRequired(true))
    .addStringOption(o => o.setName('wallet').setDescription('Mint wallet address (0x…, mainnet)').setRequired(true))
    .addStringOption(o => o.setName('max_fee_per_gas').setDescription('Max fee per gas cap (wei string)').setRequired(true))
    .addStringOption(o =>
        o.setName('max_priority_fee_per_gas').setDescription('Max priority fee cap (wei string)').setRequired(true),
    )
    .addStringOption(o => o.setName('max_total_cost_native').setDescription('Max total native cost cap (wei string)').setRequired(true))
    .addIntegerOption(o => o.setName('max_quantity').setDescription('Max mint quantity per job').setRequired(true))
    .addStringOption(o => o.setName('expires_at').setDescription('Expiry ISO-8601 (e.g. 2026-12-31T23:59:59Z)').setRequired(true))
    .addStringOption(o =>
        o
            .setName('allowed_collections')
            .setDescription('Optional comma-separated collection addresses (empty = all allowed)')
            .setRequired(false),
    );

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
    const maxFeePerGas = interaction.options.getString('max_fee_per_gas', true);
    const maxPriorityFeePerGas = interaction.options.getString('max_priority_fee_per_gas', true);
    const maxTotalCostNative = interaction.options.getString('max_total_cost_native', true);
    const maxQuantity = interaction.options.getInteger('max_quantity', true);
    const expiresAt = interaction.options.getString('expires_at', true);
    const allowedRaw = interaction.options.getString('allowed_collections');
    const allowedCollections =
        allowedRaw
            ?.split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0) ?? undefined;

    const body: Record<string, unknown> = {
        adminDiscordId: interaction.user.id,
        guildDiscordId: gid,
        userDiscordId: target.id,
        walletAddress: wallet,
        maxFeePerGas,
        maxPriorityFeePerGas,
        maxTotalCostNative,
        maxQuantity,
        expiresAt,
        approvedByDiscordId: interaction.user.id,
    };
    if (allowedCollections && allowedCollections.length > 0) {
        body.allowedCollections = allowedCollections;
    }

    const res = await mintEnginePost('/mainnet-approval/grant', body);
    const j = (await res.json()) as Record<string, unknown>;
    const embed = new EmbedBuilder()
        .setTitle('Mainnet approval')
        .setDescription(res.ok ? '**Granted** (prior active rows for this wallet were revoked).' : JSON.stringify(j).slice(0, 3500))
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
