import { mintEnv } from '../config/mintEnv';

export type MintBenchmarkSegment =
    | 'trigger_to_job_ms'
    | 'job_to_plan_ms'
    | 'plan_to_simulation_ms'
    | 'simulation_latency_ms'
    | 'signing_latency_ms'
    | 'broadcast_latency_ms'
    | 'trigger_to_first_broadcast_ms'
    | 'trigger_to_all_broadcasts_ms'
    | 'scheduled_drift_ms'
    | 'provider_latency_ms'
    | 'provider_failover_ms'
    | 'receipt_confirmation_ms'
    | 'nonce_lock_latency_ms'
    | 'gas_strategy_latency_ms'
    | 'queue_latency_ms'
    | 'mempool_detection_latency_ms'
    | 'block_detection_latency_ms'
    | 'prewarm_total_ms'
    | 'hot_path_total_ms';

export class BenchmarkService {
    private segments = new Map<string, number | null>();

    start(segment: MintBenchmarkSegment): () => void {
        if (!mintEnv.MINT_HOT_PATH_METRICS_ENABLED) return () => undefined;
        const t0 = performance.now();
        return () => {
            this.segments.set(segment, Math.round(performance.now() - t0));
        };
    }

    record(segment: MintBenchmarkSegment, ms: number | null): void {
        if (!mintEnv.MINT_HOT_PATH_METRICS_ENABLED) return;
        this.segments.set(segment, ms);
    }

    snapshot(): Record<string, number | 'not measured'> {
        const out: Record<string, number | 'not measured'> = {};
        const keys: MintBenchmarkSegment[] = [
            'trigger_to_job_ms',
            'job_to_plan_ms',
            'plan_to_simulation_ms',
            'simulation_latency_ms',
            'signing_latency_ms',
            'broadcast_latency_ms',
            'trigger_to_first_broadcast_ms',
            'trigger_to_all_broadcasts_ms',
            'scheduled_drift_ms',
            'provider_latency_ms',
            'provider_failover_ms',
            'receipt_confirmation_ms',
            'nonce_lock_latency_ms',
            'gas_strategy_latency_ms',
            'queue_latency_ms',
            'mempool_detection_latency_ms',
            'block_detection_latency_ms',
            'prewarm_total_ms',
            'hot_path_total_ms',
        ];
        for (const k of keys) {
            const v = this.segments.get(k);
            out[k] = typeof v === 'number' ? v : 'not measured';
        }
        return out;
    }
}
