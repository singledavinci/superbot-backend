import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { mintEngineGet, mintEngineHostLabel, mintEnginePost } from '../lib/mintHttp';
import {
    buildMintStatusDescription,
    formatMintExecutorEnvUnreachable,
    formatMintStatusEngineFailure,
    type MintStatusPostMerge,
} from '../lib/mintStatusDisplay';
import { mintExecutorStatusEnvBlocker, mintExecutorStatusEnvWarnings } from '../lib/mintStatusEnv';

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

    const envBlock = mintExecutorStatusEnvBlocker();
    if (envBlock) {
        await interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Mint engine status')
                    .setDescription(formatMintExecutorEnvUnreachable(envBlock))
                    .setFooter({ text: FOOTER }),
            ],
        });
        return;
    }

    let res: Response;
    try {
        res = await mintEngineGet('/health/mint-engine');
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const embed = new EmbedBuilder()
            .setTitle('Mint engine status')
            .setDescription(
                formatMintStatusEngineFailure({
                    kind: 'network',
                    message: msg,
                    engineHost: mintEngineHostLabel(),
                }),
            )
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
        const status = res.status;
        const kind = status === 401 || status === 403 ? 'auth' : 'http';
        const embed = new EmbedBuilder()
            .setTitle('Mint engine status')
            .setDescription(
                formatMintStatusEngineFailure({
                    kind,
                    message: typeof j.message === 'string' ? j.message : 'engine_error',
                    httpStatus: status,
                    bodySnippet: text,
                }),
            )
            .setFooter({ text: FOOTER });
        await interaction.editReply({ embeds: [embed] });
        return;
    }

    /** Merge HMAC **POST /v1/mint/status** (rich env/runtime) under GET health so older short GET payloads still fill Discord lines. */
    let merged: Record<string, unknown> = { ...j };
    let postMerge: MintStatusPostMerge = 'skipped';
    let postHttpStatus: number | undefined;
    try {
        const postRes = await mintEnginePost('/status', {});
        postHttpStatus = postRes.status;
        if (postRes.ok) {
            const statusText = await postRes.text();
            try {
                const statusJson = JSON.parse(statusText) as Record<string, unknown>;
                merged = { ...statusJson, ...j };
                postMerge = 'used';
            } catch {
                postMerge = 'http_error';
            }
        } else if (postRes.status === 401 || postRes.status === 403) {
            postMerge = 'auth_failed';
        } else {
            postMerge = 'http_error';
        }
    } catch {
        postMerge = 'skipped';
    }

    const warnings = mintExecutorStatusEnvWarnings();
    const body =
        buildMintStatusDescription(merged, { postStatusMerge: postMerge, postHttpStatus }) +
        (warnings.length ? '\n\n—\n' + warnings.join('\n') : '');

    const embed = new EmbedBuilder().setTitle('Mint engine status').setDescription(body).setFooter({ text: FOOTER });
    await interaction.editReply({ embeds: [embed] });
}
