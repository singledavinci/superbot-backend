/**
 * Normalize `wss://` / `ws://` RPC endpoints to HTTPS for JsonRpcProvider.
 * Mirrors the env-key style used across services.
 */
export function resolveHttpRpcUrl(
    wssEnv: string,
    httpEnv: string,
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const explicit = env[httpEnv]?.trim();
    if (explicit) return explicit;

    const wss = env[wssEnv]?.trim();
    if (!wss) return null;
    if (wss.startsWith('http://') || wss.startsWith('https://')) return wss;
    if (wss.startsWith('wss://')) return 'https://' + wss.slice('wss://'.length);
    if (wss.startsWith('ws://')) return 'http://' + wss.slice('ws://'.length);
    return null;
}

export function parseCommaSeparatedRpcUrls(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    return raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function normalizeForDedupe(url: string): string {
    return url.replace(/\/+$/, '').toLowerCase();
}

/**
 * Multi-URL env list first, then append a legacy single URL if not already present.
 */
export function mergeRpcUrlLists(multi: string[], single: string | null): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of [...multi, ...(single ? [single] : [])]) {
        const k = normalizeForDedupe(u);
        if (!seen.has(k)) {
            seen.add(k);
            out.push(u);
        }
    }
    return out;
}
