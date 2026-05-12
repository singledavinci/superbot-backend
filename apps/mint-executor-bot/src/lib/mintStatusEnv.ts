/** Blocks `/mint-status` before calling mint-engine when required executor env is missing. */
export function mintExecutorStatusEnvBlocker(): string | null {
    if (!(process.env.MINT_ENGINE_URL || '').trim()) return 'MINT_ENGINE_URL missing';
    if (!(process.env.MINT_ENGINE_SERVICE_SECRET || '').trim()) return 'MINT_ENGINE_SERVICE_SECRET missing';
    return null;
}

/** Non-fatal hints when executor env is misconfigured (never prints secrets). */
export function mintExecutorStatusEnvWarnings(): string[] {
    const w: string[] = [];
    const st = process.env.SERVICE_TYPE?.trim();
    if (st && st !== 'mint-executor-bot') {
        w.push(`SERVICE_TYPE should be **mint-executor-bot** (got: **${st}**)`);
    }
    if (process.env.MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS === 'true') {
        w.push('MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS should be **false** on the executor bot');
    }
    return w;
}
