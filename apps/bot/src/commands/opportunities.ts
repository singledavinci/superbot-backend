import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { redisConnection } from '@superbot/queue';
import { STANDARD_MARKET_DISCLAIMER } from '../embeds';

type Snap = {
    ts: number;
    contract: string;
    score: number;
    confidence: string;
    riskLabel?: string;
    signalLabel?: string;
    suspicious?: string;
    uniqueBuyers15m?: number;
    trades15m?: number;
    volume15m?: number;
    gates?: { floorUpWithTrades?: boolean };
};

const CONF_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, insufficient: 1 };

function suspiciousPenalty(s: string | undefined): number {
    if (!s || s === 'none') return 0;
    if (s === 'insufficient_data') return 3;
    if (s === 'high_risk_pump') return 2;
    if (s === 'suspicious_momentum') return 2;
    return 1;
}

function rankEntries(a: { contract: string; score: number; snap: Snap | null }, b: typeof a): number {
    if (b.score !== a.score) return b.score - a.score;
    const ca = CONF_RANK[(a.snap?.confidence || '').toLowerCase()] ?? 0;
    const cb = CONF_RANK[(b.snap?.confidence || '').toLowerCase()] ?? 0;
    if (cb !== ca) return cb - ca;
    const sa = suspiciousPenalty(a.snap?.suspicious);
    const sb = suspiciousPenalty(b.snap?.suspicious);
    if (sa !== sb) return sa - sb;
    const ub = (b.snap?.uniqueBuyers15m ?? 0) - (a.snap?.uniqueBuyers15m ?? 0);
    if (ub !== 0) return ub;
    const vol = (b.snap?.volume15m ?? 0) - (a.snap?.volume15m ?? 0);
    if (vol !== 0) return vol;
    const ft = Number(b.snap?.gates?.floorUpWithTrades === true) - Number(a.snap?.gates?.floorUpWithTrades === true);
    return ft;
}

export const data = new SlashCommandBuilder()
    .setName('opportunities')
    .setDescription('Ranked cached collection momentum signals (Redis leaderboard; no live marketplace calls)')
    .addStringOption(o =>
        o
            .setName('timeframe')
            .setDescription('Only include snapshots updated within this window')
            .addChoices(
                { name: '15m', value: '15m' },
                { name: '30m', value: '30m' },
                { name: '1h', value: '1h' },
                { name: '6h', value: '6h' },
            ),
    )
    .addNumberOption(o =>
        o.setName('min_score').setDescription('Minimum opportunity score (0–100)').setMinValue(0).setMaxValue(100),
    )
    .addIntegerOption(o =>
        o.setName('limit').setDescription('How many rows (1–10)').setMinValue(1).setMaxValue(10),
    )
    .addBooleanOption(o =>
        o
            .setName('include_high_risk')
            .setDescription('Include suspicious / high-risk momentum rows')
            .setRequired(false),
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const tf = interaction.options.getString('timeframe') || '1h';
    const tfMs =
        tf === '15m'
            ? 15 * 60 * 1000
            : tf === '30m'
              ? 30 * 60 * 1000
              : tf === '6h'
                ? 6 * 60 * 60 * 1000
                : 60 * 60 * 1000;
    const minScore = interaction.options.getNumber('min_score') ?? 35;
    const limit = interaction.options.getInteger('limit') ?? 8;
    const includeHighRisk = interaction.options.getBoolean('include_high_risk') ?? false;

    const now = Date.now();
    let pairs: string[];
    try {
        pairs = await redisConnection.zrevrange(`opportunity:leaderboard:ethereum`, 0, 49, 'WITHSCORES');
    } catch (err) {
        await interaction.editReply('Could not read opportunity leaderboard from Redis.');
        return;
    }

    const entries: { contract: string; score: number; snap: Snap | null }[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
        const contract = String(pairs[i] || '').toLowerCase();
        const score = Number(pairs[i + 1]);
        if (!contract.startsWith('0x') || contract.length !== 42 || !Number.isFinite(score)) continue;
        let snap: Snap | null = null;
        try {
            const raw = await redisConnection.get(`opportunity:snapshot:ethereum:${contract}`);
            if (raw) snap = JSON.parse(raw) as Snap;
        } catch {
            snap = null;
        }
        if (snap && now - snap.ts > tfMs) continue;
        if (score < minScore) continue;
        if (!includeHighRisk) {
            const s = snap?.suspicious;
            if (s === 'suspicious_momentum' || s === 'high_risk_pump') continue;
        }
        entries.push({ contract, score: snap?.score ?? score, snap });
    }

    entries.sort(rankEntries);
    const top = entries.slice(0, limit);

    if (top.length === 0) {
        await interaction.editReply(
            'No ranked signals matched your filters. Try a wider timeframe, lower min_score, or wait for the market-indexer opportunity tick.',
        );
        return;
    }

    const lines = top.map((e, idx) => {
        const sn = e.snap;
        const conf = sn?.confidence ? sn.confidence : '—';
        const risk = sn?.riskLabel ? sn.riskLabel : '—';
        return `**${idx + 1}.** \`${e.contract}\` — score **${e.score}** · ${conf} · ${risk}`;
    });

    const embed = new EmbedBuilder()
        .setTitle('Collection opportunity signals (cached)')
        .setDescription(lines.join('\n'))
        .setFooter({ text: STANDARD_MARKET_DISCLAIMER })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}
