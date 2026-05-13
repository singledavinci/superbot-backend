import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import { isAddress, Wallet, type TransactionRequest } from 'ethers';

function readServiceSecret(): string {
    return String(process.env.MINT_ENGINE_SERVICE_SECRET || '')
        .replace(/^\uFEFF/, '')
        .trim();
}

function readSignerPrivateKey(): string {
    const pk = process.env.SIGNER_PRIVATE_KEY || process.env.MINT_SIGNER_PRIVATE_KEY || '';
    return String(pk).replace(/^\uFEFF/, '').trim();
}

function timingSafeHexEqual(a: string, b: string): boolean {
    const as = a.trim();
    const bs = b.trim();
    if (!/^[0-9a-fA-F]+$/.test(as) || !/^[0-9a-fA-F]+$/.test(bs) || as.length % 2 !== 0 || bs.length % 2 !== 0) {
        return false;
    }
    try {
        const ab = Buffer.from(as, 'hex');
        const bb = Buffer.from(bs, 'hex');
        if (ab.length !== bb.length) return false;
        return crypto.timingSafeEqual(ab, bb);
    } catch {
        return false;
    }
}

function hmacSha256Hex(secret: string, rawBody: Buffer): string {
    return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string): string | null {
    const v = obj[key];
    if (typeof v !== 'string' || v.trim() === '') return null;
    return v;
}

function requireFiniteNumber(obj: Record<string, unknown>, key: string): number | null {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return v;
}

function requireDecimalBigIntString(obj: Record<string, unknown>, key: string): bigint | null {
    const v = obj[key];
    if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
    try {
        return BigInt(v);
    } catch {
        return null;
    }
}

function optionalNonEmptyString(obj: Record<string, unknown>, key: string): string | undefined {
    const v = obj[key];
    if (typeof v !== 'string' || v.trim() === '') return undefined;
    return v.trim();
}

function optionalDecimalBigIntString(obj: Record<string, unknown>, key: string): bigint | null | undefined {
    if (!(key in obj)) return undefined;
    const v = obj[key];
    if (v === null || v === undefined || v === '') return undefined;
    if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
    try {
        return BigInt(v);
    } catch {
        return null;
    }
}

function isHexData(s: string): boolean {
    return s.startsWith('0x') && s.length >= 2 && /^0x[0-9a-fA-F]*$/.test(s);
}

function parseAndValidateBody(raw: Buffer):
    | { ok: true; planHash: string; chainId: number; unsigned: TransactionRequest & { chainId: number } }
    | { ok: false; status: 400; error: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    } catch {
        return { ok: false, status: 400, error: 'INVALID_JSON' };
    }
    if (!isPlainObject(parsed)) {
        return { ok: false, status: 400, error: 'BODY_NOT_OBJECT' };
    }

    const planHash = requireString(parsed, 'planHash');
    if (!planHash) return { ok: false, status: 400, error: 'MISSING_PLAN_HASH' };

    const chainId = requireFiniteNumber(parsed, 'chainId');
    if (chainId === null || !Number.isInteger(chainId) || chainId <= 0) {
        return { ok: false, status: 400, error: 'INVALID_CHAIN_ID' };
    }

    const uRaw = parsed.unsigned;
    if (!isPlainObject(uRaw)) {
        return { ok: false, status: 400, error: 'MISSING_UNSIGNED' };
    }

    const uChain = requireFiniteNumber(uRaw, 'chainId');
    if (uChain === null || !Number.isInteger(uChain) || uChain <= 0) {
        return { ok: false, status: 400, error: 'INVALID_UNSIGNED_CHAIN_ID' };
    }
    if (uChain !== chainId) {
        return { ok: false, status: 400, error: 'CHAIN_ID_MISMATCH' };
    }

    const to = requireString(uRaw, 'to');
    if (!to || !isAddress(to)) return { ok: false, status: 400, error: 'INVALID_TO' };

    const data = requireString(uRaw, 'data');
    if (!data || !isHexData(data)) return { ok: false, status: 400, error: 'INVALID_DATA' };

    const value = requireDecimalBigIntString(uRaw, 'value');
    const gasLimit = requireDecimalBigIntString(uRaw, 'gasLimit');
    const maxFeePerGas = requireDecimalBigIntString(uRaw, 'maxFeePerGas');
    const maxPriorityFeePerGas = requireDecimalBigIntString(uRaw, 'maxPriorityFeePerGas');
    if (value === null || gasLimit === null || maxFeePerGas === null || maxPriorityFeePerGas === null) {
        return { ok: false, status: 400, error: 'INVALID_UNSIGNED_NUMERIC_FIELDS' };
    }

    let nonce: number | undefined;
    if ('nonce' in uRaw && uRaw.nonce !== undefined && uRaw.nonce !== null) {
        if (typeof uRaw.nonce !== 'number' || !Number.isInteger(uRaw.nonce) || uRaw.nonce < 0) {
            return { ok: false, status: 400, error: 'INVALID_NONCE' };
        }
        nonce = uRaw.nonce;
    }

    const maxTotal = optionalDecimalBigIntString(parsed, 'maxTotalCostNativeWei');
    if (maxTotal === null) {
        return { ok: false, status: 400, error: 'INVALID_MAX_TOTAL_COST_NATIVE_WEI' };
    }
    if (maxTotal !== undefined) {
        const worstCase = value + gasLimit * maxFeePerGas;
        if (worstCase > maxTotal) {
            return { ok: false, status: 400, error: 'MAX_TOTAL_COST_EXCEEDED' };
        }
    }

    // Optional correlation fields: accept presence/types loosely (mint-engine contract)
    if ('jobId' in parsed && parsed.jobId !== undefined && typeof parsed.jobId !== 'string') {
        return { ok: false, status: 400, error: 'INVALID_JOB_ID' };
    }
    const wa = optionalNonEmptyString(parsed, 'walletAddress');
    if (wa !== undefined && !isAddress(wa)) {
        return { ok: false, status: 400, error: 'INVALID_WALLET_ADDRESS' };
    }
    const cdh = optionalNonEmptyString(parsed, 'calldataHash');
    if (cdh !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(cdh)) {
        return { ok: false, status: 400, error: 'INVALID_CALLDATA_HASH' };
    }

    const tx: TransactionRequest & { chainId: number } = {
        type: 2,
        chainId,
        to,
        data,
        value,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
    };
    if (nonce !== undefined) tx.nonce = nonce;

    return { ok: true, planHash, chainId, unsigned: tx };
}

async function handleSign(req: Request, res: Response): Promise<void> {
    const secret = readServiceSecret();
    const pk = readSignerPrivateKey();
    if (!secret || !pk) {
        res.status(503).json({ error: 'SERVICE_NOT_CONFIGURED' });
        return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sigHeader = req.get('x-mint-signature') ?? '';
    const planHashHeader = req.get('x-mint-plan-hash') ?? '';

    if (!sigHeader) {
        res.status(401).json({ error: 'MISSING_SIGNATURE' });
        return;
    }

    const expected = hmacSha256Hex(secret, rawBody);
    if (!timingSafeHexEqual(sigHeader, expected)) {
        res.status(401).json({ error: 'BAD_SIGNATURE' });
        return;
    }

    const body = parseAndValidateBody(rawBody);
    if (!body.ok) {
        res.status(body.status).json({ error: body.error });
        return;
    }

    if (planHashHeader !== body.planHash) {
        res.status(401).json({ error: 'PLAN_HASH_HEADER_MISMATCH' });
        return;
    }

    let wallet: Wallet;
    try {
        wallet = new Wallet(pk);
    } catch {
        res.status(503).json({ error: 'SIGNER_KEY_INVALID' });
        return;
    }

    try {
        const rawTransaction = await wallet.signTransaction(body.unsigned);
        if (!rawTransaction.startsWith('0x')) {
            res.status(500).json({ error: 'SIGNER_INTERNAL' });
            return;
        }
        res.status(200).json({ rawTransaction });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(400).json({ error: 'SIGN_FAILED', message: msg.slice(0, 500) });
    }
}

function main(): void {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);

    const rawJson = express.raw({
        type: 'application/json',
        limit: '512kb',
    });

    app.get('/health', (_req, res) => {
        res.json({ ok: true, service: 'mint-external-signer' });
    });

    app.post('/', rawJson, (req, res, next) => {
        void handleSign(req, res).catch(next);
    });
    app.post('/sign', rawJson, (req, res, next) => {
        void handleSign(req, res).catch(next);
    });

    app.use((req, res) => {
        if (req.path === '/' || req.path === '/sign') {
            res.setHeader('Allow', 'POST');
            res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
            return;
        }
        res.status(404).json({ error: 'NOT_FOUND' });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
        console.error('[mint-external-signer] unhandled', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'INTERNAL' });
    });

    const port = Number(process.env.PORT) || 8787;
    app.listen(port, () => {
        console.log(`[mint-external-signer] listening on ${port}`);
    });
}

main();
