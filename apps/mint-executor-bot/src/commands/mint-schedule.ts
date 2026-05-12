import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

const FOOTER =
    'Execution tools are automation-based and not financial advice. Mint success is not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-schedule')
    .setDescription('Create a mint job (simulation/prepare/live per engine policy)')
    .addStringOption(o => o.setName('collection').setDescription('Collection contract').setRequired(true))
    .addStringOption(o => o.setName('wallet').setDescription('Mint wallet').setRequired(true))
    .addIntegerOption(o => o.setName('chain_id').setDescription('Chain ID (mainnet dry-run requires 1)').setRequired(false))
    .addStringOption(o =>
        o
            .setName('execution_mode')
            .setDescription('Requested mode')
            .setRequired(false)
            .addChoices(
                { name: 'simulation', value: 'simulation' },
                { name: 'prepare', value: 'prepare' },
                { name: 'live', value: 'live' },
                { name: 'mainnet_dry_run', value: 'mainnet_dry_run' },
            ),
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }
    const collection = interaction.options.getString('collection', true);
    const wallet = interaction.options.getString('wallet', true);
    const executionMode = interaction.options.getString('execution_mode') ?? 'simulation';
    const chainOpt = interaction.options.getInteger('chain_id');
    const defaultChain =
        executionMode === 'mainnet_dry_run'
            ? 1
            : Number(process.env.MINT_EXECUTOR_DEFAULT_CHAIN_ID || process.env.MINT_DEFAULT_CHAIN_ID || 11155111);
    const chainId = chainOpt ?? defaultChain;
    const res = await mintEnginePost('/jobs', {
        guildDiscordId: gid,
        userDiscordId: interaction.user.id,
        walletAddress: wallet,
        collectionAddress: collection,
        mintContract: collection,
        dropSource: 'opensea',
        dropType: 'unknown',
        triggerType: 'SCHEDULED_MINT',
        executionMode,
        chainId,
        quantity: 1,
    });
    const j = (await res.json()) as Record<string, unknown>;
    const embed = new EmbedBuilder().setTitle('Mint job').setDescription(JSON.stringify(j, null, 2).slice(0, 3800));
    embed.setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
