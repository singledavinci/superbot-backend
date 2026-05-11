import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { prisma } from '@superbot/database';
import { discordQueue } from '@superbot/queue';
import {
    NFTMetadataClient,
    CollectionNameResolver,
    createRpcPoolFromEnv,
    formatFallbackCollectionName,
    type RpcPool,
    defaultOpportunityScoreEnv,
    hotContractsSetKey,
    loadOpportunityMetricsFromRedis,
    markOpportunityHotContract,
    parseOpportunityGuildSettings,
    recordOpportunityFloorSample,
    scoreOpportunity,
    tradesInRange,
    type OpportunityScoreEnv,
} from '@superbot/analytics';
import { explainOpportunitySpike, summarizeFactsWithOptionalAi } from '@superbot/intelligence';

type AlertChannelRouting = { alertType: string; discordChannelId: string; mentionRoleId: string | null };

function discordChannelForTypes(channels: AlertChannelRouting[], preferenceOrder: string[]): string | null {
    for (const t of preferenceOrder) {
        const row = channels.find(c => c.alertType === t);
        if (row?.discordChannelId) return row.discordChannelId;
    }
    return null;
}

function mentionRoleForTypes(
    channels: { alertType: string; mentionRoleId: string | null }[],
    preferenceOrder: string[],
): string | null {
    for (const t of preferenceOrder) {
        const row = channels.find(c => c.alertType === t);
        const id = row?.mentionRoleId;
        if (typeof id === 'string' && id.trim()) return id.trim();
    }
    return null;
}

const ADDR_RE = /0x[a-fA-F0-9]{40}/gi;

export function extractContractAddressesFromEventIds(eventIds: string[]): string[] {
    const out = new Set<string>();
    for (const e of eventIds) {
        if (!e) continue;
        const m = e.match(ADDR_RE);
        if (!m) continue;
        for (const a of m) out.add(a.toLowerCase());
    }
    return [...out];
}

function bullMqJobId(parts: string): string {
    return createHash('sha256').update(parts, 'utf8').digest('hex');
}

function mergeEnvWithGuild(base: OpportunityScoreEnv, g: ReturnType<typeof parseOpportunityGuildSettings>): OpportunityScoreEnv {
    return {
        ...base,
        scoreThreshold: g.scoreThreshold ?? base.scoreThreshold,
        minUniqueBuyers: g.minUniqueBuyers ?? base.minUniqueBuyers,
    };
}

export class OpportunityMonitorRunner {
    private redis: Redis;
    private nftMetadata: NFTMetadataClient;
    private rpcPool: RpcPool | null;
    private collectionNames: CollectionNameResolver;

    constructor(redis: Redis) {
        this.redis = redis;
        this.nftMetadata = new NFTMetadataClient({ redis });
        this.rpcPool = createRpcPoolFromEnv();
        this.collectionNames = new CollectionNameResolver({
            redis,
            nftMetadata: this.nftMetadata,
            rpcPool: this.rpcPool && this.rpcPool.httpsUrls.length > 0 ? this.rpcPool : null,
        });
    }

    async collectContracts(): Promise<string[]> {
        const tracked = await prisma.trackedCollection.findMany({
            where: { chain: 'ethereum' },
            select: { contractAddress: true },
        });
        const set = new Set<string>();
        for (const t of tracked) set.add(t.contractAddress.toLowerCase());

        let hot: string[] = [];
        try {
            hot = await this.redis.smembers(hotContractsSetKey('ethereum'));
        } catch {
            hot = [];
        }
        for (const h of hot) {
            if (typeof h === 'string' && h.startsWith('0x') && h.length === 42) set.add(h.toLowerCase());
        }

        const since = new Date(Date.now() - 60 * 60 * 1000);
        const logs = await prisma.alertDeliveryLog.findMany({
            where: {
                createdAt: { gte: since },
                alertType: { in: ['SWEEP', 'CLUSTER_BUY', 'HOT_MINT', 'MASS_LISTING', 'MASS_DELIST', 'WHALE_BUY'] },
            },
            select: { eventId: true },
            take: 400,
        });
        for (const a of extractContractAddressesFromEventIds(logs.map(l => l.eventId))) {
            set.add(a);
            await markOpportunityHotContract(this.redis, 'ethereum', a).catch(() => {});
        }

        return [...set];
    }

    async evaluateAndDispatch(): Promise<void> {
        if (process.env.OPPORTUNITY_MONITOR_ENABLED === 'false') return;

        const baseEnv = defaultOpportunityScoreEnv();
        const cdMs = Number(process.env.OPPORTUNITY_ALERT_COOLDOWN_MS) || 1_800_000;
        const now = Date.now();
        const bucketTs = Math.floor(now / cdMs) * cdMs;

        const contracts = await this.collectContracts();
        if (contracts.length === 0) return;

        const chunk = 4;
        for (let i = 0; i < contracts.length; i += chunk) {
            const slice = contracts.slice(i, i + chunk);
            await Promise.all(slice.map(c => this.evaluateOne(c, baseEnv, cdMs, bucketTs, now)));
        }
    }

    private async evaluateOne(
        contract: string,
        baseEnv: OpportunityScoreEnv,
        cdMs: number,
        bucketTs: number,
        now: number,
    ) {
        const chain = 'ethereum';
        let listingDelta: number | null = null;
        try {
            const d = await this.redis.get(`opportunity:listings_delta:${contract.toLowerCase()}`);
            if (d !== null && d !== undefined && d !== '') {
                const n = Number(d);
                if (Number.isFinite(n)) listingDelta = n;
            }
        } catch {
            listingDelta = null;
        }

        const metrics = await loadOpportunityMetricsFromRedis(this.redis, chain, contract, now, {
            listingDelta15m: listingDelta,
        });
        const scoredGlobal = scoreOpportunity(metrics, baseEnv);

        if (metrics.floorNow && metrics.floorNow > 0) {
            await recordOpportunityFloorSample(this.redis, chain, contract, now, metrics.floorNow).catch(() => {});
        }

        const t15 = tradesInRange(metrics.trades, now, 15 * 60 * 1000);
        const vol15 = t15.reduce((s, x) => s + (x.priceNative > 0 ? x.priceNative : 0), 0);
        const buyers15 = new Set(t15.map(x => x.buyer)).size;

        const rows = await prisma.trackedCollection.findMany({
            where: {
                chain: 'ethereum',
                contractAddress: { equals: contract, mode: 'insensitive' },
            },
        });

        const guildIds = [...new Set(rows.map(r => r.guildId))];
        const guilds =
            guildIds.length > 0
                ? await prisma.guild.findMany({
                      where: { id: { in: guildIds } },
                      include: { alertChannels: true },
                  })
                : [];

        const guildById = new Map(guilds.map(g => [g.id, g]));

        const dispatchTargets: Array<{
            guild: (typeof guilds)[0];
            row: (typeof rows)[0] | null;
            channelId: string;
        }> = [];

        for (const row of rows) {
            const guild = guildById.get(row.guildId);
            if (!guild) continue;
            const og = parseOpportunityGuildSettings(guild.settings);
            if (!og.enabled) continue;
            const env = mergeEnvWithGuild(baseEnv, og);
            const scored = scoreOpportunity(metrics, env);
            if (!scored.shouldAlert || scored.scoreClamped < env.scoreThreshold) continue;
            const channelId =
                og.channelDiscordId ??
                discordChannelForTypes(guild.alertChannels as AlertChannelRouting[], [
                    'OPPORTUNITY_SPIKE',
                    'WHALE_BUY',
                ]) ??
                row.alertChannelId;
            if (!channelId) continue;
            dispatchTargets.push({ guild, row, channelId });
        }

        if (rows.length === 0 && scoredGlobal.shouldAlert && scoredGlobal.scoreClamped >= baseEnv.scoreThreshold) {
            const opRoutes = await prisma.alertChannel.findMany({
                where: { alertType: 'OPPORTUNITY_SPIKE' },
                include: { guild: { include: { alertChannels: true } } },
            });
            for (const ac of opRoutes) {
                const g = ac.guild;
                if (!g) continue;
                const og = parseOpportunityGuildSettings(g.settings);
                if (!og.enabled) continue;
                const env = mergeEnvWithGuild(baseEnv, og);
                const scored = scoreOpportunity(metrics, env);
                if (!scored.shouldAlert || scored.scoreClamped < env.scoreThreshold) continue;
                const channelId = og.channelDiscordId ?? ac.discordChannelId;
                if (!channelId) continue;
                dispatchTargets.push({ guild: g, row: null, channelId });
            }
        }

        const seen = new Set<string>();
        for (const target of dispatchTargets) {
            const dedupeKey = `${target.guild.id}:${target.channelId}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            await this.dispatchForGuild({
                contract,
                chain,
                now,
                bucketTs,
                cdMs,
                metrics,
                t15,
                vol15,
                buyers15,
                listingDelta,
                baseEnv,
                guild: target.guild,
                row: target.row,
                channelId: target.channelId,
            });
        }

        try {
            await this.redis.zadd(`opportunity:leaderboard:ethereum`, scoredGlobal.scoreClamped, contract.toLowerCase());
            await this.redis.expire(`opportunity:leaderboard:ethereum`, 3600);
        } catch {
            /* ignore */
        }

        try {
            await this.redis.set(
                `opportunity:snapshot:ethereum:${contract.toLowerCase()}`,
                JSON.stringify({
                    ts: now,
                    contract: contract.toLowerCase(),
                    chain: 'ethereum',
                    score: scoredGlobal.scoreClamped,
                    confidence: scoredGlobal.confidence,
                    riskLabel: scoredGlobal.riskLabel,
                    signalLabel: scoredGlobal.signalLabel,
                    suspicious: scoredGlobal.suspiciousOverride,
                    uniqueBuyers15m: buyers15,
                    trades15m: t15.length,
                    volume15m: vol15,
                    gates: scoredGlobal.gates,
                }),
                'EX',
                600,
            );
        } catch {
            /* ignore */
        }
    }

    private async dispatchForGuild(args: {
        contract: string;
        chain: string;
        now: number;
        bucketTs: number;
        cdMs: number;
        metrics: Awaited<ReturnType<typeof loadOpportunityMetricsFromRedis>>;
        t15: ReturnType<typeof tradesInRange>;
        vol15: number;
        buyers15: number;
        listingDelta: number | null;
        baseEnv: OpportunityScoreEnv;
        guild: { id: string; settings: unknown; alertChannels: AlertChannelRouting[] };
        row: { id: string; name: string; mentionRoleId: string | null; alertChannelId: string | null } | null;
        channelId: string;
    }) {
        const {
            contract,
            chain,
            now,
            bucketTs,
            cdMs,
            metrics,
            t15,
            vol15,
            buyers15,
            listingDelta,
            baseEnv,
            guild,
            row,
            channelId,
        } = args;

        const og = parseOpportunityGuildSettings(guild.settings);
        const env = mergeEnvWithGuild(baseEnv, og);
        const scored = scoreOpportunity(metrics, env);
        if (!scored.shouldAlert || scored.scoreClamped < env.scoreThreshold) return;

        const lastKey = `opportunity:last_alert:${guild.id}:${chain}:${contract.toLowerCase()}`;
        let allow = true;
        try {
            const raw = await this.redis.get(lastKey);
            if (raw) {
                const j = JSON.parse(raw) as { ts?: number; score?: number };
                const ts = Number(j.ts);
                const prev = Number(j.score);
                const useCd = og.cooldownMs ?? cdMs;
                if (Number.isFinite(ts) && now - ts < useCd) {
                    if (!(Number.isFinite(prev) && scored.scoreClamped >= prev + 15)) allow = false;
                }
            }
        } catch {
            allow = true;
        }
        if (!allow) return;

        const signalLevel = scored.signalLevel;
        const eventId = `opportunity_spike:${chain}:${contract.toLowerCase()}:${bucketTs}:${signalLevel}`;
        const jobId = bullMqJobId(`opportunity:${chain}:${contract.toLowerCase()}:${bucketTs}:${signalLevel}:${channelId}`);

        const trackedHint = row?.name;
        const { name: collectionName } = await this.collectionNames.resolve(contract.toLowerCase(), {
            trackedName: trackedHint,
        });
        const collectionMeta = await this.nftMetadata.fetchCollection(contract).catch(() => null);

        const older = metrics.trades.filter(
            t => t.tsMs >= now - 120 * 60 * 1000 && t.tsMs < now - 15 * 60 * 1000,
        );
        const baselineVol = older.length ? older.reduce((s, x) => s + x.priceNative, 0) / 7 : 0.0001;
        const volRatio = baselineVol > 0 ? vol15 / baselineVol : vol15 > 0 ? 99 : 0;

        const evidenceLines = [
            `15m trades: ${t15.length}; unique buyers: ${buyers15}.`,
            `15m volume ≈ ${vol15.toFixed(4)} ETH (~${volRatio.toFixed(2)}× vs coarse 2h baseline slice).`,
            scored.gates.sweepActivity ? 'Sweep-style prints were present in the window.' : 'No strong sweep bundle was required for this score.',
            typeof metrics.floorNow === 'number' && metrics.floorNow > 0
                ? `Reference floor cache ≈ ${metrics.floorNow.toFixed(4)} ETH.`
                : 'Floor cache was thin for this tick.',
        ];

        const cx = explainOpportunitySpike({
            collectionLabel: collectionName || formatFallbackCollectionName(contract),
            windowLabel: '15–60 minutes (rolling)',
            score: scored.scoreClamped,
            signalLabel: scored.signalLabel,
            confidenceLabel: scored.confidence,
            riskLabel: scored.riskLabel,
            evidenceLines,
            limitations: metrics.dataMissing ? ['Insufficient verified data for some venue-linked fields.'] : [],
        });
        const nar = await summarizeFactsWithOptionalAi({
            explanation: cx,
            jobCacheKey: `${jobId}-nar`,
        });

        const sweepLine =
            metrics.sweepEvents15m > 0 || metrics.sweptItems15m > 0
                ? `${metrics.sweepEvents15m} sweep events · ${metrics.sweptItems15m} items · ~${metrics.sweepNative15m.toFixed(3)} ETH notional`
                : 'No sweep bundle crossed the lightweight threshold in this window.';

        await discordQueue.add(
            'discord_alert',
            {
                eventId,
                channelId,
                alertType: 'OPPORTUNITY_SPIKE',
                contract,
                chain,
                collectionName,
                collectionMeta,
                timeWindow: '15–60m rolling',
                score: scored.scoreClamped,
                signal: scored.signalLabel,
                confidence: scored.confidence.charAt(0).toUpperCase() + scored.confidence.slice(1),
                volumeChange: `~${vol15.toFixed(4)} ETH in 15m (${volRatio.toFixed(2)}× vs coarse 2h baseline slice)`,
                tradeCount: String(t15.length),
                uniqueBuyers: String(buyers15),
                sweepActivity: sweepLine,
                floorChange:
                    typeof metrics.floorNow === 'number' && metrics.floorNow > 0
                        ? `Cached floor ≈ ${metrics.floorNow.toFixed(4)} ETH (see Redis floor history for deltas).`
                        : 'Floor cache missing — treat floor linkage as unconfirmed.',
                listingPressure:
                    listingDelta === null ? 'Unknown (listing delta not captured this poll).' : String(listingDelta),
                trackedWalletActivity:
                    metrics.trackedWalletBuys15m > 0
                        ? `${metrics.trackedWalletBuys15m} tracked-wallet buy markers in 15m`
                        : 'No tracked-wallet buy markers in 15m',
                riskFlags: scored.riskLabel,
                dataLimitations: metrics.dataMissing
                    ? 'Thin or missing venue statistics; momentum signal remains unconfirmed in places.'
                    : 'OpenSea / indexer feeds can lag real trading.',
                mentionRoleId:
                    og.mentionRoleId ??
                    mentionRoleForTypes(guild.alertChannels, ['OPPORTUNITY_SPIKE', 'WHALE_BUY']) ??
                    row?.mentionRoleId ??
                    null,
                contextualExplanation: cx,
                aiNarrative: nar ?? undefined,
            },
            {
                jobId,
                removeOnComplete: { age: 3600 },
                removeOnFail: { age: 86400 },
            },
        );

        try {
            const useCd = og.cooldownMs ?? cdMs;
            await this.redis.set(
                lastKey,
                JSON.stringify({ ts: now, score: scored.scoreClamped, signalLevel }),
                'PX',
                Math.max(useCd * 2, 120_000),
            );
        } catch {
            /* ignore */
        }
    }
}
