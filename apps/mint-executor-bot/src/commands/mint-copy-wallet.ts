import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

const FOOTER =
    'Not financial advice. Mint success not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-copy-wallet')
    .setDescription('Configure copy-mint (saved per server)')
    .addStringOption(o => o.setName('tracked_wallet').setDescription('Wallet to follow (0x…)').setRequired(true))
    .addStringOption(o => o.setName('execution_wallet_id').setDescription('MintWallet id from dashboard').setRequired(true))
    .addStringOption(o =>
        o
            .setName('mode')
            .setDescription('Copy mode')
            .setRequired(true)
            .addChoices(
                { name: 'confirmed_only', value: 'confirmed_only' },
                { name: 'pending_if_visible', value: 'pending_if_visible' },
            ),
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }
    const tracked = interaction.options.getString('tracked_wallet', true);
    const executionWalletId = interaction.options.getString('execution_wallet_id', true);
    const mode = interaction.options.getString('mode', true);
    const res = await mintEnginePost('/copy-config/save', {
        guildDiscordId: gid,
        userDiscordId: interaction.user.id,
        trackedWalletAddress: tracked,
        executionWalletId,
        mode,
        quantity: 1,
        enabled: true,
    });
    const j = await res.json();
    const embed = new EmbedBuilder()
        .setTitle('Copy-mint config')
        .setDescription(JSON.stringify(j, null, 2).slice(0, 3800))
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
