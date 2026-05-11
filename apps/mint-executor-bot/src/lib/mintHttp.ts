import { createHash, createHmac, randomBytes } from 'crypto';

function sha256Hex(body: string): string {
    return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function signMintRequest(args: {
    secret: string;
    method: string;
    path: string;
    timestampSec: number;
    nonce: string;
    body: string;
}): string {
    const msg =
        args.method.toUpperCase() +
        '\n' +
        args.path +
        '\n' +
        String(args.timestampSec) +
        '\n' +
        args.nonce +
        '\n' +
        sha256Hex(args.body);
    return createHmac('sha256', args.secret).update(msg, 'utf8').digest('hex');
}

export async function mintEnginePost(path: string, jsonBody: Record<string, unknown>): Promise<Response> {
    const base = (process.env.MINT_ENGINE_URL || 'http://127.0.0.1:3847').replace(/\/+$/, '');
    const fullPath = `/v1/mint${path}`;
    const url = `${base}${fullPath}`;
    const secret = (process.env.MINT_ENGINE_SERVICE_SECRET || '').replace(/^\uFEFF/, '').trim();
    if (!secret) throw new Error('MINT_ENGINE_SERVICE_SECRET is not set');
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString('hex');
    const body = JSON.stringify(jsonBody);
    const sig = signMintRequest({ secret, method: 'POST', path: fullPath, timestampSec: ts, nonce, body });
    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-SUPERBOT-SERVICE': 'mint-executor-bot',
            'X-SUPERBOT-TIMESTAMP': String(ts),
            'X-SUPERBOT-NONCE': nonce,
            'X-SUPERBOT-SIGNATURE': sig,
        },
        body,
    });
}
