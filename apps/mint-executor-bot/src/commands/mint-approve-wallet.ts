import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

export const data = new SlashCommandBuilder()
    .setName('mint-approve-wallet')
    .setDescription('Grant mainnet execution approval for one wallet (mint admins only)')
    .addStringOption(o => o.setName('wallet').setDescription('Wallet address (0x…, chain 1)').setRequired(true))
    .addUserOption(o =>
        o.setName('target_user').setDescription('Discord user this approval is for (defaults to you)').setRequired(false),
    )
    .addStringOption(o => o.setName('max_fee_per_gas').setDescription('Gas cap: maxFeePerGas (wei string, e.g. gwei decimal)').setRequired(true))
    .addStringOption(o =>
        o.setName('max_priority_fee_per_gas').setDescription('Gas cap: maxPriorityFeePerGas (wei string)').setRequired(true),
    )
    .addStringOption(o =>
        o.setName('max_total_cost_native').setDescription('Max total native cost cap (decimal string, ETH units per engine env)').setRequired(true),
    )
    .addIntegerOption(o =>
        o.setName('max_quantity').setDescription('Max mint quantity allowed by this approval').setRequired(false).setMinValue(1),
    )
    .addIntegerOption(o =>
        o
            .setName('expires_in_hours')
            .setDescription('Approval validity from now (hours)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(24 * 365),
    )
    .addStringOption(o =>
        o
            .setName('allowed_collections')
            .setDescription('Optional comma-separated collection 0x addresses; omit or empty = unrestricted')
            .setRequired(false),
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }

    const walletRaw = interaction.options.getString('wallet', true).trim();
    const walletAddress = walletRaw.toLowerCase();
    const targetUser = interaction.options.getUser('target_user');
    const userDiscordId = targetUser?.id ?? interaction.user.id;

    const maxFeePerGas = interaction.options.getString('max_fee_per_gas', true).trim();
    const maxPriorityFeePerGas = interaction.options.getString('max_priority_fee_per_gas', true).trim();
    const maxTotalCostNative = interaction.options.getString('max_total_cost_native', true).trim();
    const maxQuantity = interaction.options.getInteger('max_quantity') ?? 1;
    const expiresInHours = interaction.options.getInteger('expires_in_hours') ?? 168;

    const collectionsRaw = interaction.options.getString('allowed_collections')?.trim() ?? '';
    let allowedCollections: string[] | undefined;
    if (collectionsRaw.length > 0) {
        const arr = collectionsRaw
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
        if (arr.length > 0) allowedCollections = arr;
    }

    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();

    const body: Record<string, unknown> = {
        adminDiscordId: interaction.user.id,
        guildDiscordId: gid,
        userDiscordId,
        walletAddress,
        maxFeePerGas,
        maxPriorityFeePerGas,
        maxTotalCostNative,
        maxQuantity,
        expiresAt,
        approvedByDiscordId: interaction.user.id,
    };
    if (allowedCollections !== undefined) {
        body.allowedCollections = allowedCollections;
    }

    let res: Response;
    try {
        res = await mintEnginePost('/mainnet-approval/grant', body);
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

    await interaction.editReply(
        [
            'Mainnet approval **granted**.',
            `Wallet: \`${walletAddress}\``,
            `User: <@${userDiscordId}>`,
            `maxQuantity: **${maxQuantity}**`,
            `expiresAt (UTC): **${expiresAt}**`,
            'Gas/cost caps stored on server (not shown here).',
        ].join('\n'),
    );
}
