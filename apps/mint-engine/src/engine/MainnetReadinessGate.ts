import type { PrismaClient } from '@superbot/database';
import { mintEnv } from '../config/mintEnv';

const REQUIRED_KEYS = [
    'signer_safety_ok',
    'nonce_safety_ok',
    'scheduler_drift_ok',
    'simulation_ok',
    'gas_caps_ok',
    'broadcast_ok',
    'recovery_ok',
    'emergency_stop_drill_ok',
    'testnet_live_ok',
] as const;

export type ReadinessKey = (typeof REQUIRED_KEYS)[number];

export class MainnetReadinessGate {
    constructor(private prisma: PrismaClient) {}

    async allChecksTrue(): Promise<boolean> {
        const row = await this.prisma.mintMainnetReadiness.findUnique({ where: { id: 'default' } });
        const checklist = (row?.checklistJson as Record<string, boolean> | null) ?? {};
        for (const k of REQUIRED_KEYS) {
            if (!checklist[k]) return false;
        }
        if (mintEnv.MINT_TESTNET_LIVE_VERIFIED_AT) {
            const t = Date.parse(mintEnv.MINT_TESTNET_LIVE_VERIFIED_AT);
            if (!Number.isFinite(t)) return false;
        }
        return true;
    }

    async setCheck(key: ReadinessKey, value: boolean): Promise<void> {
        const existing = await this.prisma.mintMainnetReadiness.findUnique({ where: { id: 'default' } });
        const cur = { ...((existing?.checklistJson as Record<string, boolean> | null) ?? {}), [key]: value };
        await this.prisma.mintMainnetReadiness.upsert({
            where: { id: 'default' },
            create: { id: 'default', checklistJson: cur },
            update: { checklistJson: cur },
        });
    }
}
