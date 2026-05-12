import type { PrismaClient } from '@superbot/database';
import { mintEnv } from '../config/mintEnv';

/** Env OR persisted DB emergency (OR semantics). */
export async function getEffectiveEmergencyStop(prisma: PrismaClient): Promise<boolean> {
    if (mintEnv.MINT_EMERGENCY_STOP) return true;
    const row = await prisma.mintEngineRuntimeState.findUnique({ where: { id: 'default' } }).catch(() => null);
    return row?.emergencyStop === true;
}

export async function setRuntimeEmergencyStop(prisma: PrismaClient, active: boolean): Promise<void> {
    await prisma.mintEngineRuntimeState.upsert({
        where: { id: 'default' },
        create: { id: 'default', emergencyStop: active },
        update: { emergencyStop: active },
    });
}
