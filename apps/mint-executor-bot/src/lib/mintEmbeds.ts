import { EmbedBuilder } from 'discord.js';

const DISCLAIMER =
    'Execution tools are automation-based and not financial advice. Mint success is not guaranteed. Never share seed phrases or private keys. Transactions may fail or cost gas.';

function str(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v || '—';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
}

/** Fields for /mint-preflight from mint-engine JSON body. */
export function buildMintPreflightEmbed(j: Record<string, unknown>, title = 'Mint preflight'): EmbedBuilder {
    const ok = Boolean(j.ok);
    const err = str(j.error);
    const verified = j.verifiedDrop as Record<string, unknown> | undefined;
    const dropType = verified?.dropType != null ? str(verified.dropType) : '—';
    const mintTo = verified?.seaDropContract ?? verified?.mintContract;
    const price = verified?.priceNative != null ? str(verified.priceNative) : '—';
    const start = verified?.startTime != null ? str(verified.startTime) : '—';
    const end = verified?.endTime != null ? str(verified.endTime) : '—';
    const unsigned = j.unsignedPrepare as Record<string, unknown> | undefined;
    const unsignedPresent = Boolean(unsigned && Object.keys(unsigned).length > 0);
    const sim = j.simulation as Record<string, unknown> | undefined;
    const simStatus = sim?.status != null ? str(sim.status) : '—';

    const embed = new EmbedBuilder()
        .setTitle(title)
        .addFields(
            { name: 'ok', value: ok ? 'true' : 'false', inline: true },
            { name: 'executionMode', value: str(j.executionMode), inline: true },
            { name: 'resolverStatus', value: str(j.resolverStatus), inline: true },
            { name: 'error', value: ok ? '—' : err, inline: false },
            { name: 'blockReason', value: str(j.blockReason).slice(0, 1024), inline: false },
            { name: 'dropType', value: dropType, inline: true },
            { name: 'mint / SeaDrop (to)', value: str(mintTo).slice(0, 1024), inline: false },
            { name: 'price (wei)', value: price.slice(0, 256), inline: true },
            { name: 'startTime (ms)', value: start.slice(0, 128), inline: true },
            { name: 'endTime (ms)', value: end.slice(0, 128), inline: true },
            { name: 'planHash', value: str(j.planHash).slice(0, 128), inline: false },
            { name: 'simulationStatus', value: simStatus.slice(0, 256), inline: true },
            { name: 'unsignedPrepare', value: unsignedPresent ? 'present' : 'absent', inline: true },
            { name: 'livePolicy', value: str(j.livePolicy).slice(0, 256), inline: true },
            { name: 'persistJobId', value: str(j.persistJobId), inline: true },
        )
        .setFooter({ text: DISCLAIMER });

    return embed;
}

/** Fields for /mint-result from `/jobs/result` job payload. */
export function buildMintJobResultEmbed(payload: Record<string, unknown>, title = 'Mint job result'): EmbedBuilder {
    const job = (payload.job as Record<string, unknown>) ?? payload;
    const sims = job.simulations as unknown[] | undefined;
    const lastSim = sims?.[0] as Record<string, unknown> | undefined;
    const meta = job.metadataJson as Record<string, unknown> | undefined;
    const pre = meta?.preflightLast as Record<string, unknown> | undefined;

    const embed = new EmbedBuilder()
        .setTitle(title)
        .addFields(
            { name: 'job id', value: str(job.id).slice(0, 128), inline: false },
            { name: 'MintJob status', value: str(job.status), inline: true },
            { name: 'executionMode', value: str(job.executionMode), inline: true },
            { name: 'planHash', value: str(job.planHash).slice(0, 128), inline: false },
            { name: 'simulationStatus (job)', value: str(job.simulationStatus), inline: true },
            { name: 'errorCode', value: str(job.errorCode), inline: true },
            { name: 'MintSimulation (latest)', value: lastSim ? str(lastSim.status) : '—', inline: true },
            { name: 'blockReason (metadata)', value: str(pre?.blockReason).slice(0, 1024), inline: false },
            { name: 'unsignedPrepare (metadata)', value: str(pre?.unsignedPreparePresent), inline: true },
            { name: 'signingOccurred', value: str(pre?.signingOccurred), inline: true },
            { name: 'broadcastOccurred', value: str(pre?.broadcastOccurred), inline: true },
        )
        .setFooter({ text: DISCLAIMER });

    return embed;
}
