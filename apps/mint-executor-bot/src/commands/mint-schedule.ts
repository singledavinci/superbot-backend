import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

const FOOTER =
    'Not financial advice. Mint success not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-schedule')
    .setDescription('Create a mint job (simulation/prepare/live per engine policy)')
    .addStringOption(o => o.setName('collection').setDescription('Collection contract').setRequired(true))
    .addStringOption(o => o.setName('wallet').setDescription('Mint wallet').setRequired(true))
    .addStringOption(o =>
        o
            .setName('execution_mode')
            .setDescription('Requested mode')
            .setRequired(false)
            .addChoices(
                { name: 'simulation', value: 'simulation' },
                { name: 'prepare', value: 'prepare' },
                { name: 'live', value: 'live' },
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
        chainId: 1,
        quantity: 1,
    });
    const j = (await res.json()) as Record<string, unknown>;
    const embed = new EmbedBuilder().setTitle('Mint job').setDescription(JSON.stringify(j, null, 2).slice(0, 3800));
    embed.setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
