import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';
import { buildMintPreflightEmbed } from '../lib/mintEmbeds';

export const data = new SlashCommandBuilder()
    .setName('mint-preflight')
    .setDescription('Resolve drop, plan, and simulate (no signing, no broadcast)')
    .addStringOption(o => o.setName('collection').setDescription('Collection contract (0x…)').setRequired(true))
    .addStringOption(o => o.setName('wallet').setDescription('Your mint wallet address').setRequired(true))
    .addIntegerOption(o => o.setName('chain_id').setDescription('Chain ID').setRequired(false))
    .addIntegerOption(o => o.setName('quantity').setDescription('Quantity').setRequired(false))
    .addStringOption(o => o.setName('drop_source').setDescription('Drop source').setRequired(false))
    .addStringOption(o =>
        o
            .setName('execution_mode')
            .setDescription('simulation = dry run; prepare = unsigned payload emphasis')
            .setRequired(false)
            .addChoices(
                { name: 'simulation', value: 'simulation' },
                { name: 'prepare', value: 'prepare' },
            ),
    )
    .addStringOption(o => o.setName('job_id').setDescription('Optional MintJob UUID to persist plan/sim on job').setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }
    const collection = interaction.options.getString('collection', true);
    const wallet = interaction.options.getString('wallet', true);
    const chainId = interaction.options.getInteger('chain_id') ?? 1;
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const dropSource = interaction.options.getString('drop_source') ?? 'opensea';
    const executionMode = interaction.options.getString('execution_mode') ?? undefined;
    const jobId = interaction.options.getString('job_id') ?? undefined;

    const body: Record<string, unknown> = {
        guildDiscordId: gid,
        userDiscordId: interaction.user.id,
        walletAddress: wallet,
        collectionAddress: collection,
        dropSource,
        chainId,
        quantity,
    };
    if (executionMode) body.executionMode = executionMode;
    if (jobId) body.persistJobId = jobId;

    const res = await mintEnginePost('/preflight', body);
    if (!res.ok) {
        const t = await res.text();
        await interaction.editReply({ content: `Mint engine HTTP ${res.status}: ${t.slice(0, 500)}` });
        return;
    }
    const j = (await res.json()) as Record<string, unknown>;
    const embed = buildMintPreflightEmbed(j);
    await interaction.editReply({ embeds: [embed] });
}
