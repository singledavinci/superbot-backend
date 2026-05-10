import { JsonRpcProvider, WebSocketProvider } from 'ethers';
import {
    mergeRpcUrlLists,
    parseCommaSeparatedRpcUrls,
    resolveHttpRpcUrl,
} from './rpcUrls';

/** JsonRpc reads (eth_getTransactionReceipt, etc.). */
export const HTTPS_RPC_JSON_TIMEOUT_MS = Number(process.env.HTTPS_RPC_JSON_TIMEOUT_MS) || 25_000;

const BLACKLIST_MS = 60_000;
const STRIKES_BEFORE_BLACKLIST = 3;

/** Slot marker for JsonRpcProvider instances from this pool. */
const HTTPS_SLOT = Symbol.for('superbot.rpcPool.httpsSlot');

/** Slot marker WebSocketProvider from this pool. */
const WSS_SLOT = Symbol.for('superbot.rpcPool.wssSlot');

/**
 * Provider label safe for logs: first subdomain label truncated to 8 chars (no path / secrets).
 */
export function slugLabelForRpcUrl(url: string): string {
    try {
        const normalized = url.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
        const u = new URL(normalized);
        const first = u.hostname.split('.')[0] || '';
        const s = first.slice(0, 8);
        return s.length > 0 ? s : '(unknown)';
    } catch {
        return '(unknown)';
    }
}

function isLikely429(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    if (/429/.test(msg) || /\brate limit\b/i.test(msg)) return true;
    const code = (e as { code?: string; info?: { responseStatus?: string } })?.info?.responseStatus;
    return code === '429';
}

function isLikely5xx(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    if (/50[0-9]/.test(msg)) return true;
    const code = (e as { code?: string })?.code;
    return code === 'SERVER_ERROR';
}

export function isRetryableHttpRpcError(e: unknown): boolean {
    return isLikely429(e) || isLikely5xx(e);
}

export interface RpcPoolInit {
    httpsUrls: string[];
    wssUrls: string[];
}

/**
 * Multi-endpoint Ethereum RPC pool: round-robin HTTPS, rotating WSS with blacklist on 429 streaks.
 * Initialization is idempotent; providers are created lazily per slot.
 */
export class RpcPool {
    readonly httpsUrls: string[];
    readonly wssUrls: string[];

    private httpsProviders: (JsonRpcProvider | undefined)[] = [];
    private httpsRR = 0;
    private readonly httpsStrike429: number[] = [];
    private readonly httpsBlacklistUntil: number[] = [];
    private readonly httpsLastFail: number[] = [];

    private wssCursor = 0;
    private readonly wssStrike429: number[] = [];
    private readonly wssBlacklistUntil: number[] = [];
    private readonly wssLastFail: number[] = [];

    constructor(init: RpcPoolInit) {
        this.httpsUrls = [...init.httpsUrls];
        this.wssUrls = [...init.wssUrls];
        this.initArrays(this.httpsUrls.length, this.httpsStrike429, this.httpsBlacklistUntil, this.httpsLastFail);
        this.initArrays(this.wssUrls.length, this.wssStrike429, this.wssBlacklistUntil, this.wssLastFail);
        console.log(
            `[RpcPool] Initialized with ${this.httpsUrls.length} HTTPS / ${this.wssUrls.length} WSS providers`,
        );
    }

    private initArrays(
        n: number,
        strikes: number[],
        blacklistUntil: number[],
        lastFail: number[],
    ) {
        strikes.length = 0;
        blacklistUntil.length = 0;
        lastFail.length = 0;
        for (let i = 0; i < n; i++) {
            strikes.push(0);
            blacklistUntil.push(0);
            lastFail.push(0);
        }
    }

    private pickLeastRecentlyFailed(n: number, lastFail: number[]): number {
        let best = 0;
        let bestTS = Infinity;
        for (let i = 0; i < n; i++) {
            const ts = lastFail[i] ?? 0;
            if (ts < bestTS) {
                bestTS = ts;
                best = i;
            }
        }
        return best;
    }

    private pickHttpsSlot(): number {
        const n = this.httpsUrls.length;
        if (n === 0) throw new Error('RpcPool: no HTTPS URLs configured');
        const now = Date.now();

        for (let i = 0; i < n; i++) {
            const idx = (this.httpsRR + i) % n;
            if ((this.httpsBlacklistUntil[idx] ?? 0) <= now) {
                this.httpsRR = (idx + 1) % n;
                return idx;
            }
        }

        const idx = this.pickLeastRecentlyFailed(n, this.httpsLastFail);
        this.httpsRR = (idx + 1) % n;
        return idx;
    }

    /** Round-robin JsonRpcProvider; skips slots blacklisted until {@link BLACKLIST_MS} elapses after 429 streaks. */
    getHttpsProvider(): JsonRpcProvider {
        const idx = this.pickHttpsSlot();
        if (!this.httpsProviders[idx]) {
            const p = new JsonRpcProvider(this.httpsUrls[idx], undefined, { staticNetwork: true });
            (p as unknown as Record<symbol, number>)[HTTPS_SLOT] = idx;
            this.httpsProviders[idx] = p;
        }
        return this.httpsProviders[idx]!;
    }

    slotForHttpsProvider(p: JsonRpcProvider): number | undefined {
        return (p as unknown as Record<symbol, number>)[HTTPS_SLOT];
    }

    markHttpsSuccess(provider: JsonRpcProvider) {
        const idx = this.slotForHttpsProvider(provider);
        if (idx === undefined) return;
        this.httpsStrike429[idx] = 0;
    }

    markHttps429(provider: JsonRpcProvider) {
        const idx = this.slotForHttpsProvider(provider);
        if (idx === undefined) return;
        const now = Date.now();
        this.httpsLastFail[idx] = now;
        const s = (this.httpsStrike429[idx] ?? 0) + 1;
        this.httpsStrike429[idx] = s;
        if (s >= STRIKES_BEFORE_BLACKLIST) {
            this.httpsBlacklistUntil[idx] = now + BLACKLIST_MS;
            console.warn(
                `[RpcPool] HTTPS ${slugLabelForRpcUrl(this.httpsUrls[idx])} … blacklisted ${BLACKLIST_MS / 1000}s (${s} successive 429s)`,
            );
        }
    }

    httpsLabel(provider: JsonRpcProvider): string {
        const idx = this.slotForHttpsProvider(provider);
        if (idx === undefined) return slugLabelForRpcUrl('');
        return slugLabelForRpcUrl(this.httpsUrls[idx]);
    }

    private pickInitialWssSlot(): number {
        const n = this.wssUrls.length;
        if (n === 0) throw new Error('RpcPool: no WSS URLs configured');
        const now = Date.now();

        for (let i = 0; i < n; i++) {
            const idx = i;
            if ((this.wssBlacklistUntil[idx] ?? 0) <= now) return idx;
        }

        return this.pickLeastRecentlyFailed(n, this.wssLastFail);
    }

    private pickNextWssSlotAfterDisconnect(): number {
        const n = this.wssUrls.length;
        if (n === 0) throw new Error('RpcPool: no WSS URLs configured');
        const now = Date.now();

        for (let step = 1; step <= n; step++) {
            const idx = (this.wssCursor + step) % n;
            if ((this.wssBlacklistUntil[idx] ?? 0) <= now) return idx;
        }

        return this.pickLeastRecentlyFailed(n, this.wssLastFail);
    }

    /** First WebSocket connection: picks a usable WSS slot (round-robin / blacklist aware). */
    getWssProvider(): WebSocketProvider {
        const idx = this.pickInitialWssSlot();
        this.wssCursor = idx;
        return this.instantiateWss(idx);
    }

    /**
     * After disconnect / hard failure: caller should `destroy()` the old provider first.
     * Selects the next eligible WSS URL.
     */
    rotateWssProvider(reason: string): WebSocketProvider {
        const next = this.pickNextWssSlotAfterDisconnect();
        this.wssCursor = next;
        const p = this.instantiateWss(next);
        console.log(`[RpcPool] WSS rotate (${reason}) → ${slugLabelForRpcUrl(this.wssUrls[next])}…`);
        return p;
    }

    private instantiateWss(idx: number): WebSocketProvider {
        const p = new WebSocketProvider(this.wssUrls[idx]);
        (p as unknown as Record<symbol, number>)[WSS_SLOT] = idx;
        return p;
    }

    slotForWssProvider(p: WebSocketProvider): number | undefined {
        return (p as unknown as Record<symbol, number>)[WSS_SLOT];
    }

    wssLabel(p: WebSocketProvider): string {
        const idx = this.slotForWssProvider(p);
        if (idx === undefined) return '(unknown)';
        return slugLabelForRpcUrl(this.wssUrls[idx]);
    }

    markWssOpen(p: WebSocketProvider) {
        const idx = this.slotForWssProvider(p);
        if (idx === undefined) return;
        this.wssStrike429[idx] = 0;
    }

    recordWss429Message(p: WebSocketProvider, err: unknown) {
        if (!isLikely429(err)) return;
        const idx = this.slotForWssProvider(p);
        if (idx === undefined) return;
        const now = Date.now();
        this.wssLastFail[idx] = now;
        const s = (this.wssStrike429[idx] ?? 0) + 1;
        this.wssStrike429[idx] = s;
        if (s >= STRIKES_BEFORE_BLACKLIST) {
            this.wssBlacklistUntil[idx] = now + BLACKLIST_MS;
            console.warn(
                `[RpcPool] WSS ${slugLabelForRpcUrl(this.wssUrls[idx])} … blacklisted ${BLACKLIST_MS / 1000}s (${s} successive 429s)`,
            );
        }
    }
}

/**
 * Build merged URL lists from env. Legacy single `WSS_RPC_URL` / derived HTTPS are appended when missing from multi-vars.
 */
export function createRpcPoolFromEnv(): RpcPool | null {
    const legacyHttp = resolveHttpRpcUrl('WSS_RPC_URL', 'HTTPS_RPC_URL');
    let httpsUrls = mergeRpcUrlLists(
        parseCommaSeparatedRpcUrls(process.env.HTTPS_RPC_URLS),
        legacyHttp ?? null,
    );

    let wssUrls = mergeRpcUrlLists(
        parseCommaSeparatedRpcUrls(process.env.WSS_RPC_URLS),
        process.env.WSS_RPC_URL?.trim() || null,
    );

    if (httpsUrls.length === 0 && wssUrls.length > 0) {
        httpsUrls = wssUrls.map(u =>
            u.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://'),
        );
    }

    const hasHttps = httpsUrls.length > 0;
    const hasWss = wssUrls.length > 0;
    if (!hasHttps && !hasWss) return null;

    return new RpcPool({
        httpsUrls: hasHttps ? httpsUrls : [],
        wssUrls: hasWss ? wssUrls : [],
    });
}
