import { JsonRpcProvider } from 'ethers';
import type { PrismaClient } from '@superbot/database';
import { mintEnv } from '../config/mintEnv';
import type { UnsignedTx } from './TransactionBuilder';

export type SimulationStatus =
    | 'PASS'
    | 'PASS_STAGE_NOT_OPEN_YET'
    | 'FAIL_REVERT'
    | 'FAIL_NOT_STARTED'
    | 'FAIL_ENDED'
    | 'FAIL_NOT_ELIGIBLE'
    | 'FAIL_MISSING_PROOF'
    | 'FAIL_WALLET_LIMIT'
    | 'FAIL_SOLD_OUT'
    | 'FAIL_INSUFFICIENT_FUNDS'
    | 'FAIL_GAS_CAP'
    | 'FAIL_UNKNOWN_FUNCTION'
    | 'FAIL_UNKNOWN_PRICE'
    | 'DEGRADED_PROVIDER_ERROR';

export interface SimulationResult {
    status: SimulationStatus;
    gasEstimate: string | null;
    revertReason: string | null;
}

function mapRevertMessage(msg: string): SimulationStatus {
    const m = msg.toLowerCase();
    if (m.includes('not eligible') || m.includes('not eligible to mint')) return 'FAIL_NOT_ELIGIBLE';
    if (m.includes('proof') || m.includes('merkle')) return 'FAIL_MISSING_PROOF';
    if (m.includes('sold out') || m.includes('soldout')) return 'FAIL_SOLD_OUT';
    if (m.includes('wallet limit') || m.includes('max per wallet') || m.includes('already minted')) {
        return 'FAIL_WALLET_LIMIT';
    }
    if (m.includes('insufficient funds') || m.includes('insufficient balance')) return 'FAIL_INSUFFICIENT_FUNDS';
    if (m.includes('gas') && (m.includes('cap') || m.includes('limit') || m.includes('too low'))) return 'FAIL_GAS_CAP';
    if (m.includes('not started') || m.includes('sale not started')) return 'FAIL_NOT_STARTED';
    if (m.includes('ended') || m.includes('sale ended')) return 'FAIL_ENDED';
    if (m.includes('function') && m.includes('selector')) return 'FAIL_UNKNOWN_FUNCTION';
    return 'FAIL_REVERT';
}

export class SimulationEngine {
    constructor(private rpcUrl: string | null) {}

    async simulate(from: string, tx: UnsignedTx, opts?: { dropStartMs?: number | null }): Promise<SimulationResult> {
        if (!this.rpcUrl) {
            return { status: 'DEGRADED_PROVIDER_ERROR', gasEstimate: null, revertReason: 'NO_HTTPS_RPC' };
        }
        const provider = new JsonRpcProvider(this.rpcUrl);
        const callPromise = provider.call({
            from,
            to: tx.to,
            data: tx.data,
            value: tx.value,
        });
        const timeoutMs = mintEnv.MINT_SIMULATION_TIMEOUT_MS;
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('SIM_TIMEOUT')), timeoutMs);
        });
        try {
            await Promise.race([callPromise, timeoutPromise]);
            const now = Date.now();
            if (opts?.dropStartMs != null && opts.dropStartMs > now) {
                return { status: 'PASS_STAGE_NOT_OPEN_YET', gasEstimate: String(tx.gasLimit), revertReason: null };
            }
            return { status: 'PASS', gasEstimate: String(tx.gasLimit), revertReason: null };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === 'SIM_TIMEOUT' || msg.includes('429') || msg.includes('timeout') || msg.includes('503')) {
                return { status: 'DEGRADED_PROVIDER_ERROR', gasEstimate: null, revertReason: msg };
            }
            const st = mapRevertMessage(msg);
            return { status: st, gasEstimate: null, revertReason: msg };
        }
    }

    async persist(prisma: PrismaClient, mintJobId: string, sim: SimulationResult): Promise<void> {
        await prisma.mintSimulation.create({
            data: {
                mintJobId,
                status: sim.status,
                result: sim.status,
                gasEstimate: sim.gasEstimate,
                revertReason: sim.revertReason,
            },
        });
    }
}
