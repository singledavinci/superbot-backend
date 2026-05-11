import { mintEnv } from '../config/mintEnv';

/** Confirmed mint events → enqueue mint_triggers (optional). */
export class ChainEventWatcher {
    start(): void {
        if (!mintEnv.MINT_COPY_CONFIRMED_ENABLED) return;
        console.log('[ChainEventWatcher] subscribe via worker bridge in Phase 6; engine idle');
    }
}
