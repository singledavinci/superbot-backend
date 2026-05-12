/** Single display value for Discord — never "undefined". */
export function displayHealthField(v: unknown): string {
    if (v === undefined || v === null) return 'missing';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    if (typeof v === 'string') return v === '' ? 'missing' : v;
    return String(v);
}

/**
 * Discord embed body lines from GET /health/mint-engine JSON (snake-free camelCase keys).
 */
export function buildMintStatusDescription(j: Record<string, unknown>): string {
    const lines: string[] = [
        `Mode: **${displayHealthField(j.mode)}**`,
        `Live execution flag: **${displayHealthField(j.executionEnabled)}**`,
        `Mainnet broadcast: **${displayHealthField(j.mainnetBroadcastEnabled)}**`,
        `Emergency stop: **${displayHealthField(j.emergencyStop)}**`,
        `Testnet only: **${displayHealthField(j.testnetOnly)}**`,
        `Signer configured: **${displayHealthField(j.signerConfigured)}**`,
        `Default chain id: **${displayHealthField(j.defaultChainId)}**`,
        `Mainnet beta: **${displayHealthField(j.mainnetBeta)}**`,
        `Mainnet dry-run: **${displayHealthField(j.mainnetDryRun)}**`,
        `Copy-mint live: **${displayHealthField(j.copyMintLiveEnabled)}**`,
        `Private relay: **${displayHealthField(j.privateRelayEnabled)}**`,
        `Auto replace: **${displayHealthField(j.autoReplaceEnabled)}**`,
        `Manual confirmation: **${displayHealthField(j.manualConfirmationRequired)}**`,
        `Max active jobs: **${displayHealthField(j.maxActiveJobs)}**`,
        `Max quantity: **${displayHealthField(j.maxQuantity)}**`,
    ];
    return lines.join('\n');
}

export function formatMintStatusEngineFailure(args: {
    kind: 'network' | 'http';
    message: string;
    httpStatus?: number;
    bodySnippet?: string;
}): string {
    if (args.kind === 'network') {
        return [
            `Engine reachable: **no**`,
            `Error: **${displayHealthField(args.message)}**`,
            `Hint: check **MINT_ENGINE_URL** points at the mint-engine service.`,
        ].join('\n');
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
