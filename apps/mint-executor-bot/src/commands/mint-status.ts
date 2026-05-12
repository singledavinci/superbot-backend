import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

const FOOTER =
    'Execution tools are automation-based and not financial advice. Mint success is not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

export const data = new SlashCommandBuilder()
    .setName('mint-status')
    .setDescription('Mint engine mode, caps, signer, RPC health, and clock drift');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }
    const res = await mintEnginePost('/status', {
        guildDiscordId: gid,
        userDiscordId: interaction.user.id,
    });
    const j = (await res.json()) as Record<string, unknown>;
    const eff = (j as { emergencyStopEffective?: boolean }).emergencyStopEffective;
    const envStop = (j as { emergencyStopEnv?: boolean }).emergencyStopEnv;
    const dry = (j as { mainnetDryRunEnabled?: boolean }).mainnetDryRunEnabled;
    const betaW = (j as { mainnetBetaWalletConfigured?: boolean }).mainnetBetaWalletConfigured;
    const betaOn = (j as { mainnetBetaEnabled?: boolean }).mainnetBetaEnabled;
    const signerOk = (j as { signerMainnetApproved?: boolean }).signerMainnetApproved;
    const activeMn = (j as { activeMainnetJobCount?: number }).activeMainnetJobCount;
    const rpcH = (j as { rpcHealth?: unknown[] }).rpcHealth;
    const rpcOk = Array.isArray(rpcH) && rpcH.length > 0;
    const embed = new EmbedBuilder()
        .setTitle('Mint engine status')
        .setDescription(
            `Mode: **${j.engineMode}**\nLive execution flag: **${j.liveExecutionEnabled}**\nMainnet broadcast: **${j.mainnetBroadcastEnabled}** (disabled = safe)\nMainnet beta flag: **${betaOn ?? '—'}**\nEmergency stop (env): **${envStop ?? '—'}**\nEmergency stop (effective): **${eff ?? '—'}**\nMainnet dry-run flag: **${dry ?? '—'}**\nMainnet beta wallet env set: **${betaW ?? '—'}**\nActive mainnet jobs (chain 1): **${typeof activeMn === 'number' ? activeMn : '—'}**\nSigner mainnet approved (env): **${signerOk ?? '—'}**\nProvider health rows: **${rpcOk ? rpcH!.length : 0}**\nTestnet only: **${j.testnetOnly}**\nSigner configured: **${j.signerConfigured}**\nDefault chain id (env): **${typeof (j as { defaultChainId?: number }).defaultChainId === 'number' ? (j as { defaultChainId: number }).defaultChainId : '—'}**`,
        )
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
