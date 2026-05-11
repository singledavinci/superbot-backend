import { JsonRpcProvider } from 'ethers';
import { mintEnv } from '../config/mintEnv';

export class ClockSyncMonitor {
    constructor(private rpcUrl: string | null) {}

    async measureDriftMs(): Promise<{ ok: boolean; driftMs: number; message?: string }> {
        if (!mintEnv.MINT_CLOCK_DRIFT_CHECK_ENABLED) return { ok: true, driftMs: 0 };
        if (!this.rpcUrl) return { ok: true, driftMs: 0, message: 'no_rpc' };
        try {
            const p = new JsonRpcProvider(this.rpcUrl);
            const block = await p.getBlock('latest');
            if (!block) return { ok: false, driftMs: -1, message: 'no_block' };
            const chainMs = Number(block.timestamp) * 1000;
            const driftMs = Math.abs(Date.now() - chainMs);
            const ok = driftMs <= mintEnv.MINT_SCHEDULE_DRIFT_WARN_MS * 10;
            return { ok, driftMs, message: ok ? undefined : 'HIGH_DRIFT' };
        } catch (e: unknown) {
            return { ok: false, driftMs: -1, message: e instanceof Error ? e.message : String(e) };
        }
    }
}
