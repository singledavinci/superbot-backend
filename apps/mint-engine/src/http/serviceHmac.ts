import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/** Path string that must match the client HMAC `path` line (full path from app root). */
export function requestPathForSigning(req: Request): string {
    const base = req.baseUrl || '';
    const p = req.path || '';
    if (base || p) {
        const joined = `${base}${p.startsWith('/') ? p : `/${p}`}`;
        return joined || '/';
    }
    try {
        const u = new URL(req.originalUrl || req.url || '/', 'http://local');
        return u.pathname;
    } catch {
        return req.path || '/';
    }
}
import type IORedis from 'ioredis';
import { mintEnv } from '../config/mintEnv';

const REDIS_NONCE_KEY = 'mint:s2s:nonce:';

/** Read secret at request time so runtime env (e.g. Railway) always matches in-process updates. */
export function readMintEngineServiceSecret(): string {
    return (process.env.MINT_ENGINE_SERVICE_SECRET || '').replace(/^\uFEFF/, '').trim();
}

export function sha256HexBody(body: Buffer | string): string {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    return createHash('sha256').update(buf).digest('hex');
}

export function signServiceRequest(args: {
    secret: string;
    method: string;
    path: string;
    timestampSec: number;
    nonce: string;
    body: string;
}): string {
    const method = args.method.toUpperCase();
    const ts = String(args.timestampSec);
    const msg =
        method +
        '\n' +
        args.path +
        '\n' +
        ts +
        '\n' +
        args.nonce +
        '\n' +
        sha256HexBody(args.body);
    return createHmac('sha256', args.secret).update(msg, 'utf8').digest('hex');
}

export function generateServiceNonce(): string {
    return randomBytes(16).toString('hex');
}

function hexToBuf(hex: string): Buffer | null {
    const s = hex.trim();
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) return null;
    return Buffer.from(s, 'hex');
}

/**
 * Express middleware: verify X-SUPERBOT-* HMAC for mutating routes.
 * Expects body to be raw (express.raw or buffer) for POST — use express.json after raw only for routes that need JSON parse separately.
 * For JSON routes, use verifyJsonHmac after express.json() by re-serializing canonical JSON or store rawBody at verify time.
 */
export function createHmacAuthMiddleware(redis: IORedis | null) {
    return async function hmacAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
        const secret = readMintEngineServiceSecret();
        if (!secret) {
            console.error('[MintEngine][auth] MINT_ENGINE_SERVICE_SECRET is not set');
            res.status(503).json({ error: 'SERVICE_AUTH_NOT_CONFIGURED' });
            return;
        }

        const service = req.header('x-superbot-service');
        const tsRaw = req.header('x-superbot-timestamp');
        const nonce = req.header('x-superbot-nonce');
        const sig = req.header('x-superbot-signature');

        if (!service || !tsRaw || !nonce || !sig) {
            console.warn('[MintEngine][auth] missing_header', { service: service ?? '', path: req.path });
            res.status(401).json({ error: 'MISSING_AUTH_HEADERS' });
            return;
        }

        const ts = Number(tsRaw);
        if (!Number.isFinite(ts)) {
            res.status(401).json({ error: 'INVALID_TIMESTAMP' });
            return;
        }

        const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
        if (skew > mintEnv.MINT_API_MAX_CLOCK_SKEW_SEC) {
            console.warn('[MintEngine][auth] expired', { service, path: req.path, skewSec: skew });
            res.status(401).json({ error: 'TIMESTAMP_EXPIRED' });
            return;
        }

        if (redis) {
            const nk = REDIS_NONCE_KEY + nonce;
            const ok = await redis.set(nk, '1', 'EX', mintEnv.MINT_API_NONCE_REDIS_TTL_SEC, 'NX');
            if (ok !== 'OK') {
                console.warn('[MintEngine][auth] replay', { service, path: req.path });
                res.status(401).json({ error: 'REPLAY_NONCE' });
                return;
            }
        } else {
            console.warn('[MintEngine][auth] redis unavailable; replay protection disabled');
        }

        const rawBody =
            typeof (req as unknown as { rawBody?: Buffer }).rawBody !== 'undefined'
                ? (req as unknown as { rawBody: Buffer }).rawBody
                : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}), 'utf8');

        const pathOnly = requestPathForSigning(req);
        const expected = signServiceRequest({
            secret,
            method: req.method,
            path: pathOnly,
            timestampSec: ts,
            nonce,
            body: rawBody.toString('utf8'),
        });

        const sigBuf = hexToBuf(sig);
        const expBuf = hexToBuf(expected);
        const bodySha = sha256HexBody(rawBody);
        const allowDiag = mintEnv.MINT_ENGINE_MODE !== 'live';
        const diag = allowDiag
            ? {
                  signPath: pathOnly,
                  bodySha256: bodySha,
                  secretLen: secret.length,
                  expectedSigPrefix: expected.slice(0, 10),
              }
            : {};
        if (!sigBuf || !expBuf || sigBuf.length !== expBuf.length) {
            console.warn('[MintEngine][auth] bad_signature', { service, path: req.path, pathOnly, ts, ...diag });
            res.status(401).json({ error: 'BAD_SIGNATURE', ...diag });
            return;
        }
        if (!timingSafeEqual(sigBuf, expBuf)) {
            console.warn('[MintEngine][auth] bad_signature', { service, path: req.path, pathOnly, ts, ...diag });
            res.status(401).json({ error: 'BAD_SIGNATURE', ...diag });
            return;
        }

        next();
    };
}

/** Attach raw body for HMAC verification on selected routes. */
export function rawBodySaver(req: Request, _res: Response, buf: Buffer): void {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
}
