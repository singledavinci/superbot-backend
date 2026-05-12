/** First defined value among keys (for GET health vs POST /status field-name drift). */
export function pickStatusField(j: Record<string, unknown>, keys: string[]): unknown {
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(j, k)) continue;
        const v = j[k];
        if (v !== undefined && v !== null) return v;
    }
    return undefined;
}

/** Single display value for Discord — never "undefined" or empty-looking garbage. */
export function displayHealthField(v: unknown): string {
    if (v === undefined || v === null) return 'missing';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    if (typeof v === 'string') {
        const t = v.trim();
        if (t === '') return 'missing';
        const low = t.toLowerCase();
        if (low === 'undefined' || low === 'null' || low === 'nan') return 'missing';
        return v;
    }
    const s = String(v);
    if (s === 'undefined' || s === 'null') return 'missing';
    return s;
}

/**
 * Discord embed body lines from GET /health/mint-engine JSON (snake-free camelCase keys).
 */
export function buildMintStatusDescription(j: Record<string, unknown>): string {
    const lines: string[] = [
        `Mode: **${displayHealthField(pickStatusField(j, ['mode', 'engineMode']))}**`,
        `Live execution flag: **${displayHealthField(pickStatusField(j, ['executionEnabled', 'liveExecutionEnabled']))}**`,
        `Mainnet broadcast: **${displayHealthField(pickStatusField(j, ['mainnetBroadcastEnabled']))}**`,
        `Emergency stop: **${displayHealthField(pickStatusField(j, ['emergencyStop', 'emergencyStopEffective']))}**`,
        `Testnet only: **${displayHealthField(pickStatusField(j, ['testnetOnly']))}**`,
        `Signer configured: **${displayHealthField(pickStatusField(j, ['signerConfigured']))}**`,
        `Default chain id: **${displayHealthField(pickStatusField(j, ['defaultChainId']))}**`,
        `Mainnet beta: **${displayHealthField(pickStatusField(j, ['mainnetBeta', 'mainnetBetaEnabled']))}**`,
        `Mainnet dry-run: **${displayHealthField(pickStatusField(j, ['mainnetDryRun', 'mainnetDryRunEnabled']))}**`,
        `Copy-mint live: **${displayHealthField(pickStatusField(j, ['copyMintLiveEnabled']))}**`,
        `Private relay: **${displayHealthField(pickStatusField(j, ['privateRelayEnabled']))}**`,
        `Auto replace: **${displayHealthField(pickStatusField(j, ['autoReplaceEnabled']))}**`,
        `Manual confirmation: **${displayHealthField(pickStatusField(j, ['manualConfirmationRequired']))}**`,
        `Max active jobs: **${displayHealthField(pickStatusField(j, ['maxActiveJobs', 'mainnetMaxActiveJobs']))}**`,
        `Max quantity: **${displayHealthField(pickStatusField(j, ['maxQuantity', 'mainnetMaxQuantity']))}**`,
    ];
    return lines.join('\n');
}

export type MintStatusFailureKind = 'network' | 'http' | 'auth';

export function formatMintStatusEngineFailure(args: {
    kind: MintStatusFailureKind;
    message: string;
    httpStatus?: number;
    bodySnippet?: string;
    /** From `MINT_ENGINE_URL` host only — never a secret. */
    engineHost?: string | null;
}): string {
    if (args.kind === 'network') {
        return [
            `Engine reachable: **no**`,
            args.engineHost ? `Engine URL host: **${displayHealthField(args.engineHost)}**` : '',
            `Error: **${displayHealthField(args.message)}**`,
            `Hint: check **MINT_ENGINE_URL** points at the mint-engine service.`,
        ]
            .filter(Boolean)
            .join('\n');
    }
    if (args.kind === 'auth') {
        const snip = (args.bodySnippet || '').slice(0, 400);
        return [
            `**Engine auth failed**`,
            `HTTP status: **${args.httpStatus ?? 'missing'}**`,
            `Error: **${displayHealthField(args.message)}**`,
            snip ? `Response: **${snip}**` : '',
        ]
            .filter(Boolean)
            .join('\n');
    }
    const snip = (args.bodySnippet || '').slice(0, 400);
    return [
        `Engine reachable: **yes**`,
        `HTTP status: **${args.httpStatus ?? 'missing'}**`,
        args.message ? `Error: **${displayHealthField(args.message)}**` : '',
        snip ? `Response: **${snip}**` : '',
    ]
        .filter(Boolean)
        .join('\n');
}
