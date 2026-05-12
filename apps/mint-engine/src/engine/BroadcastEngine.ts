import { JsonRpcProvider, Transaction } from 'ethers';
import { mintEnv } from '../config/mintEnv';
import { assertMainnetBroadcastAllowed } from './mainnetGuard';

export interface BroadcastResult {
    provider: string;
    ok: boolean;
    latencyMs: number;
    response?: string;
    error?: string;
}

export class BroadcastEngine {
    async broadcastRaw(args: {
        rawTransaction: string;
        urls: string[];
        emergencyStopActive?: boolean;
    }): Promise<BroadcastResult[]> {
        if (mintEnv.MINT_EMERGENCY_STOP || args.emergencyStopActive) {
            return [{ provider: 'policy', ok: false, latencyMs: 0, error: 'MAINNET_EMERGENCY_STOP_ACTIVE' }];
        }
        let parsed: Transaction;
        try {
            parsed = Transaction.from(args.rawTransaction);
        } catch {
            return [
                {
                    provider: 'engine',
                    ok: false,
                    latencyMs: 0,
                    error: 'invalid raw transaction',
                },
            ];
        }
        try {
            assertMainnetBroadcastAllowed(Number(parsed.chainId));
        } catch (e: unknown) {
            return [
                {
                    provider: 'policy',
                    ok: false,
                    latencyMs: 0,
                    error: e instanceof Error ? e.message : String(e),
                },
            ];
        }

        const results: BroadcastResult[] = [];
        const urls = args.urls.slice(0, mintEnv.MINT_MAX_RPC_BROADCASTS);
        for (const url of urls) {
            const t0 = performance.now();
            try {
                const p = new JsonRpcProvider(url);
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), mintEnv.MINT_BROADCAST_TIMEOUT_MS);
                const hash = await p.send('eth_sendRawTransaction', [args.rawTransaction]);
                clearTimeout(timer);
                results.push({
                    provider: url,
                    ok: true,
                    latencyMs: Math.round(performance.now() - t0),
                    response: String(hash),
                });
            } catch (e: unknown) {
                results.push({
                    provider: url,
                    ok: false,
                    latencyMs: Math.round(performance.now() - t0),
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }
        return results;
    }
}
