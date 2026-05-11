/** Deterministic JSON for plan hashing (sorted keys, arrays preserved). */
export function canonicalStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(o[k])}`);
    return `{${parts.join(',')}}`;
}
