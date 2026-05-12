import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEngineGet } from '../lib/mintHttp';
import { buildMintStatusDescription, formatMintStatusEngineFailure } from '../lib/mintStatusDisplay';

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

    let res: Response;
    try {
        res = await mintEngineGet('/health/mint-engine');
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const embed = new EmbedBuilder()
            .setTitle('Mint engine status')
            .setDescription(formatMintStatusEngineFailure({ kind: 'network', message: msg }))
            .setFooter({ text: FOOTER });
        await interaction.editReply({ embeds: [embed] });
        return;
    }

    const text = await res.text();
    let j: Record<string, unknown>;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        const embed = new EmbedBuilder()
            .setTitle('Mint engine status')
            .setDescription(
                formatMintStatusEngineFailure({
                    kind: 'http',
                    message: 'invalid_json',
                    httpStatus: res.status,
                    bodySnippet: text,
                }),
            )
            .setFooter({ text: FOOTER });
        await interaction.editReply({ embeds: [embed] });
        return;
    }

    if (!res.ok || j.ok === false) {
        const embed = new EmbedBuilder()
            .setTitle('Mint engine status')
            .setDescription(
                formatMintStatusEngineFailure({
                    kind: 'http',
                    message: typeof j.message === 'string' ? j.message : 'engine_error',
                    httpStatus: res.status,
                    bodySnippet: text,
                }),
            )
            .setFooter({ text: FOOTER });
        await interaction.editReply({ embeds: [embed] });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('Mint engine status')
        .setDescription(buildMintStatusDescription(j))
        .setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
