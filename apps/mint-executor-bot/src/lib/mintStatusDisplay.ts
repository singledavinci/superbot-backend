/** First defined value among keys (for GET health vs POST /status field-name drift). */
export function pickStatusField(j: Record<string, unknown>, keys: string[]): unknown {
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(j, k)) continue;
        const v = j[k];
        if (v !== undefined && v !== null) return v;
    }
    return undefined;
}

/**
 * Safe single-line display for Discord — never the literal `undefined` / empty garbage.
 * Prefer this name over legacy `displayHealthField`.
 */
export function formatStatusValue(value: unknown): string {
    if (value === undefined || value === null) return 'missing';
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (typeof value === 'string') {
        const t = value.trim();
        if (t === '') return 'missing';
        const low = t.toLowerCase();
        if (low === 'undefined' || low === 'null' || low === 'nan') return 'missing';
        return value;
    }
    const s = String(value);
    if (s === 'undefined' || s === 'null') return 'missing';
    return s;
}

/** @deprecated use {@link formatStatusValue} */
export function displayHealthField(v: unknown): string {
    return formatStatusValue(v);
}

const REQUIRED_STATUS_KEYS: { label: string; keys: string[] }[] = [
    { label: 'mode', keys: ['mode', 'engineMode'] },
    { label: 'executionEnabled', keys: ['executionEnabled', 'liveExecutionEnabled'] },
    { label: 'mainnetBroadcastEnabled', keys: ['mainnetBroadcastEnabled'] },
    { label: 'mainnetBeta', keys: ['mainnetBeta', 'mainnetBetaEnabled'] },
    { label: 'emergencyStop', keys: ['emergencyStop', 'emergencyStopEffective'] },
    { label: 'testnetOnly', keys: ['testnetOnly'] },
    { label: 'signerConfigured', keys: ['signerConfigured'] },
    { label: 'signerMode', keys: ['signerMode'] },
    { label: 'signerMainnetApproved', keys: ['signerMainnetApproved'] },
    { label: 'signerAddressMasked', keys: ['signerAddressMasked'] },
    { label: 'defaultChainId', keys: ['defaultChainId'] },
];

/** True if any of `keys` exists on `j` (value may be `null` — counts as present for schema completeness). */
export function statusKeyExists(j: Record<string, unknown>, keys: string[]): boolean {
    for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(j, k)) return true;
    }
    return false;
}

export function isMintHealthPayloadIncomplete(j: Record<string, unknown>): boolean {
    for (const { keys } of REQUIRED_STATUS_KEYS) {
        if (!statusKeyExists(j, keys)) return true;
    }
    return false;
}

function strictBool(v: unknown): boolean | undefined {
    if (v === true || v === false) return v;
    return undefined;
}

function strictNum(v: unknown): number | undefined {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return undefined;
}

function strictStr(v: unknown): string | undefined {
    if (typeof v === 'string' && v.trim() !== '') return v;
    return undefined;
}

/**
 * Mainnet proof readiness per mint-engine policy (display-only).
 * Requires a complete payload; if incomplete, callers should treat as not ready.
 */
export function computeMainnetProofReadiness(j: Record<string, unknown>): { ready: boolean; blockers: string[] } {
    const blockers: string[] = [];
    if (isMintHealthPayloadIncomplete(j)) {
        blockers.push('status payload incomplete');
        return { ready: false, blockers };
    }

    const mode = pickStatusField(j, ['mode', 'engineMode']);
    if (mode !== 'live') blockers.push(mode === undefined ? 'mode missing' : `mode is not live (got: ${formatStatusValue(mode)})`);

    const exec = strictBool(pickStatusField(j, ['executionEnabled', 'liveExecutionEnabled']));
    if (exec !== true) blockers.push('execution not enabled');

    const broadcast = strictBool(pickStatusField(j, ['mainnetBroadcastEnabled']));
    if (broadcast !== true) blockers.push('mainnet broadcast disabled');

    const beta = strictBool(pickStatusField(j, ['mainnetBeta', 'mainnetBetaEnabled']));
    if (beta !== true) blockers.push('mainnet beta disabled');

    const estop = strictBool(pickStatusField(j, ['emergencyStop', 'emergencyStopEffective']));
    if (estop !== false) blockers.push('emergency stop active');

    const testOnly = strictBool(pickStatusField(j, ['testnetOnly']));
    if (testOnly !== false) blockers.push('testnet only enabled');

    const signer = strictBool(pickStatusField(j, ['signerConfigured']));
    if (signer !== true) blockers.push('signer not configured');

    const signerMainnetOk = strictBool(pickStatusField(j, ['signerMainnetApproved']));
    if (signer === true && signerMainnetOk !== true) blockers.push('signer not mainnet approved');

    const chain = strictNum(pickStatusField(j, ['defaultChainId']));
    if (chain !== 1) blockers.push(chain === undefined ? 'default chain id missing' : `default chain id is not 1 (got: ${formatStatusValue(chain)})`);

    const maxJobs = strictNum(pickStatusField(j, ['maxActiveJobs', 'mainnetMaxActiveJobs']));
    if (maxJobs !== 1) blockers.push(maxJobs === undefined ? 'max active jobs missing' : `maxActiveJobs is not 1 (got: ${formatStatusValue(maxJobs)})`);

    const maxQty = strictNum(pickStatusField(j, ['maxQuantity', 'mainnetMaxQuantity']));
    if (maxQty !== 1) blockers.push(maxQty === undefined ? 'max quantity missing' : `maxQuantity is not 1 (got: ${formatStatusValue(maxQty)})`);

    const copyLive = strictBool(pickStatusField(j, ['copyMintLiveEnabled']));
    if (copyLive !== false) blockers.push('copy-mint live is enabled');

    const privRelay = strictBool(pickStatusField(j, ['privateRelayEnabled']));
    if (privRelay !== false) blockers.push('private relay is enabled');

    return { ready: blockers.length === 0, blockers };
}

export type MintStatusPostMerge = 'used' | 'auth_failed' | 'http_error' | 'skipped';

export type MintStatusBuildContext = {
    /** POST /v1/mint/status merge outcome (enrichment). */
    postStatusMerge: MintStatusPostMerge;
    postHttpStatus?: number;
};

function postMergeLine(ctx: MintStatusBuildContext): string {
    if (ctx.postStatusMerge === 'used') return 'Engine detail merge (POST /v1/mint/status): **ok**';
    if (ctx.postStatusMerge === 'auth_failed') {
        const st = ctx.postHttpStatus != null ? String(ctx.postHttpStatus) : 'missing';
        return `Engine detail merge (POST /v1/mint/status): **auth failed** (HTTP **${st}**) — some fields may be **missing**`;
    }
    if (ctx.postStatusMerge === 'http_error') {
        const st = ctx.postHttpStatus != null ? String(ctx.postHttpStatus) : 'missing';
        return `Engine detail merge (POST /v1/mint/status): **failed** (HTTP **${st}**) — some fields may be **missing**`;
    }
    return 'Engine detail merge (POST /v1/mint/status): **skipped** (network or error) — using GET health only';
}

/**
 * Discord embed body lines from merged GET /health/mint-engine + optional POST /status JSON.
 */
export function buildMintStatusDescription(
    j: Record<string, unknown>,
    ctx: MintStatusBuildContext = { postStatusMerge: 'skipped' },
): string {
    const lines: string[] = [
        `Engine reachable: **yes**`,
        postMergeLine(ctx),
        '',
        `Mode: **${formatStatusValue(pickStatusField(j, ['mode', 'engineMode']))}**`,
        `Live execution flag: **${formatStatusValue(pickStatusField(j, ['executionEnabled', 'liveExecutionEnabled']))}**`,
        `Mainnet broadcast: **${formatStatusValue(pickStatusField(j, ['mainnetBroadcastEnabled']))}**`,
        `Mainnet beta: **${formatStatusValue(pickStatusField(j, ['mainnetBeta', 'mainnetBetaEnabled']))}**`,
        `Mainnet dry-run: **${formatStatusValue(pickStatusField(j, ['mainnetDryRun', 'mainnetDryRunEnabled']))}**`,
        `Emergency stop: **${formatStatusValue(pickStatusField(j, ['emergencyStop', 'emergencyStopEffective']))}**`,
        `Runtime emergency DB: **${formatStatusValue(pickStatusField(j, ['runtimeEmergencyStopAvailable']))}**`,
        `Testnet only: **${formatStatusValue(pickStatusField(j, ['testnetOnly']))}**`,
        `Signer configured: **${formatStatusValue(pickStatusField(j, ['signerConfigured']))}**`,
        `Signer mode: **${formatStatusValue(pickStatusField(j, ['signerMode']))}**`,
        `Signer mainnet approved: **${formatStatusValue(pickStatusField(j, ['signerMainnetApproved']))}**`,
        `Signer address (masked): **${formatStatusValue(pickStatusField(j, ['signerAddressMasked']))}**`,
    ];
    const sbr = pickStatusField(j, ['signerBlockReason']);
    if (typeof sbr === 'string' && sbr.trim() !== '') {
        lines.push(`Signer block reason: **${formatStatusValue(sbr)}**`);
    }
    lines.push(
        `Default chain id: **${formatStatusValue(pickStatusField(j, ['defaultChainId']))}**`,
        `Copy-mint live: **${formatStatusValue(pickStatusField(j, ['copyMintLiveEnabled']))}**`,
        `Private relay: **${formatStatusValue(pickStatusField(j, ['privateRelayEnabled']))}**`,
        `Auto replace: **${formatStatusValue(pickStatusField(j, ['autoReplaceEnabled']))}**`,
        `Manual confirmation: **${formatStatusValue(pickStatusField(j, ['manualConfirmationRequired']))}**`,
        `Max active jobs: **${formatStatusValue(pickStatusField(j, ['maxActiveJobs', 'mainnetMaxActiveJobs']))}**`,
        `Max quantity: **${formatStatusValue(pickStatusField(j, ['maxQuantity', 'mainnetMaxQuantity']))}**`,
        `Health schema: **${formatStatusValue(pickStatusField(j, ['healthSchemaVersion']))}**`,
    );

    const incomplete = isMintHealthPayloadIncomplete(j);
    if (incomplete) {
        const missing = REQUIRED_STATUS_KEYS.filter(({ keys }) => !statusKeyExists(j, keys)).map((x) => x.label);
        lines.push(
            '',
            '**Status payload incomplete.** Do not run mainnet proof.',
            `Required fields: **${missing.join(', ')}**`,
            `mainnetProofReady: **false**`,
        );
    }

    const readiness = computeMainnetProofReadiness(j);
    lines.push('', `Mainnet proof readiness: **${readiness.ready ? 'ready' : 'not ready'}**`);
    if (!readiness.ready) {
        const first = readiness.blockers[0] ?? 'unknown';
        lines.push(`First blocker: **${formatStatusValue(first)}**`);
        if (readiness.blockers.length > 1) {
            lines.push(`Other blockers: **${readiness.blockers.slice(1).map(formatStatusValue).join('; ')}**`);
        }
    }

    const out = lines.join('\n');
    if (out.includes('undefined')) {
        return out.replace(/\bundefined\b/g, 'missing');
    }
    return out;
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
            args.engineHost ? `Engine URL host: **${formatStatusValue(args.engineHost)}**` : '',
            `Error: **${formatStatusValue(args.message)}**`,
            `Hint: check **MINT_ENGINE_URL** points at the mint-engine service.`,
        ]
            .filter(Boolean)
            .join('\n');
    }
    if (args.kind === 'auth') {
        const snip = (args.bodySnippet || '').slice(0, 400);
        return [
            `**Engine auth failed**`,
            `HTTP status: **${args.httpStatus != null ? String(args.httpStatus) : 'missing'}**`,
            `Error: **${formatStatusValue(args.message)}**`,
            snip ? `Response: **${formatStatusValue(snip)}**` : '',
        ]
            .filter(Boolean)
            .join('\n');
    }
    const snip = (args.bodySnippet || '').slice(0, 400);
    return [
        `Engine reachable: **yes**`,
        `HTTP status: **${args.httpStatus != null ? String(args.httpStatus) : 'missing'}**`,
        args.message ? `Error: **${formatStatusValue(args.message)}**` : '',
        snip ? `Response: **${formatStatusValue(snip)}**` : '',
    ]
        .filter(Boolean)
        .join('\n');
}

/** When executor env blocks the engine call (missing URL or secret). */
export function formatMintExecutorEnvUnreachable(reason: string): string {
    return [`Engine reachable: **no**`, `Reason: **${formatStatusValue(reason)}**`].join('\n');
}
