import { mintEnv } from '../config/mintEnv';

/** Pending-tx watcher (disabled unless MINT_COPY_PENDING_ENABLED). */
export class MempoolWatcher {
    start(): void {
        if (!mintEnv.MINT_MEMPOOL_WATCH_ENABLED || !mintEnv.MINT_COPY_PENDING_ENABLED) return;
        console.log('[MempoolWatcher] pending-copy disabled by default; no subscription started');
    }
}
