import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { mintEnginePost } from '../lib/mintHttp';

export const data = new SlashCommandBuilder()
    .setName('mint-approvals')
    .setDescription('List active mainnet execution approvals for this server (mint admins only)')
    .addUserOption(o =>
        o.setName('target_user').setDescription('Filter to one Discord user (optional)').setRequired(false),
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const gid = interaction.guildId;
    if (!gid) {
        await interaction.editReply('Use this command in a server.');
        return;
    }

    const target = interaction.options.getUser('target_user');
    const body: Record<string, unknown> = {
        adminDiscordId: interaction.user.id,
        guildDiscordId: gid,
    };
    if (target) body.userDiscordId = target.id;

    let res: Response;
    try {
        res = await mintEnginePost('/mainnet-approval/list', body);
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

    let j: Record<string, unknown>;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        await interaction.editReply(`Invalid JSON from mint-engine: ${text.slice(0, 300)}`);
        return;
    }

    const list = j.approvals as unknown[] | undefined;
    if (!Array.isArray(list) || list.length === 0) {
        await interaction.editReply('No **active** mainnet approvals for this server (or filter returned none).');
        return;
    }

    const lines = list.slice(0, 20).map((raw, i) => {
        const a = raw as Record<string, unknown>;
        const wallet = String(a.walletAddress ?? '?');
        const uid = String(a.userDiscordId ?? '?');
        const exp = String(a.expiresAt ?? '?');
        const caps = a.capsPresent === true ? 'caps ok' : 'caps missing';
        const mq = String(a.maxQuantity ?? '?');
        return `${i + 1}. <@${uid}> \`${wallet}\` qty≤${mq} · ${caps} · exp **${exp}**`;
    });
    const more = list.length > 20 ? `\n… and ${list.length - 20} more (showing first 20).` : '';
    await interaction.editReply(['**Active mainnet approvals**', ...lines, more].join('\n').slice(0, 3900));
}
