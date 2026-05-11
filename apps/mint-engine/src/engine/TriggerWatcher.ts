/** Normalizes trigger payloads into MintJob candidates. */
export class TriggerWatcher {
    parseTriggerPayload(body: unknown): { type: string; payload: Record<string, unknown> } | null {
        if (!body || typeof body !== 'object') return null;
        const o = body as Record<string, unknown>;
        const type = typeof o.type === 'string' ? o.type : '';
        if (!type) return null;
        return { type, payload: o };
    }
}
