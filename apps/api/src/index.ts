import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as dotenv from 'dotenv';
import { prisma } from '@superbot/database';
import jwt from 'jsonwebtoken';
import axios from 'axios';

dotenv.config();

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

function parseEthAddress(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    return ETH_ADDRESS_RE.test(s) ? s.toLowerCase() : null;
}

/** Discord channel or role snowflake. */
function parseSnowflake(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    return DISCORD_SNOWFLAKE_RE.test(s) ? s : null;
}

async function prismaGuildInternalIdOr404(
    discordGuildId: string,
    res: express.Response,
): Promise<string | null> {
    const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
    if (!guild) {
        res.status(404).json({ error: 'Guild not found' });
        return null;
    }
    return guild.id;
}

async function collectGuildDeliveryDiscordChannelIds(guildInternalId: string): Promise<string[]> {
    const guild = await prisma.guild.findUnique({
        where: { id: guildInternalId },
        include: {
            alertChannels: true,
            trackedWallets: true,
            trackedCollections: true,
        },
    });
    if (!guild) return [];
    const ids = new Set<string>();
    for (const ch of guild.alertChannels) {
        if (ch.discordChannelId) ids.add(ch.discordChannelId);
    }
    for (const w of guild.trackedWallets) {
        if (w.alertChannelId) ids.add(w.alertChannelId);
    }
    for (const col of guild.trackedCollections) {
        if (col.alertChannelId) ids.add(col.alertChannelId);
        if (col.hotMintChannelId) ids.add(col.hotMintChannelId);
        if (col.delistChannelId) ids.add(col.delistChannelId);
    }
    return [...ids];
}

function decodeJwtDiscordUserId(req: express.Request): string | null {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return null;
        const token = authHeader.slice('Bearer '.length).trim();
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key') as { id?: string };
        return typeof decoded.id === 'string' && decoded.id.trim() ? decoded.id.trim() : null;
    } catch {
        return null;
    }
}

const ALERT_TYPE_PARAM_RE = /^[A-Z][A-Z0-9_]*$/;

interface DashboardJwtPayload {
    id?: string;
    username?: string;
    /** Preferred guild (Discord snowflake). */
    guildId?: string;
    /** Discord snowflakes where the user may access SuperBot guild routes (staff of that server). */
    eligibleGuildIds?: string[];
    /** Bumped when JWT claims shape changes; clients must re-auth when stale. */
    authSchemaVersion?: number;
}

/** Increment when JWT or session semantics change; embed in new JWTs and surface via `/auth/me`. */
const AUTH_SCHEMA_VERSION = 2;

type JwtTimingFields = { iat?: number; exp?: number };

/** Discord `@me/guilds` permission flags: Administrator (0x8) or Manage Guild (0x20). */
function canManageDiscordServer(permissionsRaw: string): boolean {
    try {
        const p = BigInt(permissionsRaw);
        const ADMIN = 8n;
        const MANAGE_GUILD = 32n;
        return (p & ADMIN) !== 0n || (p & MANAGE_GUILD) !== 0n;
    } catch {
        return false;
    }
}

function discordGuildsEligibleForJwt(
    userGuilds: Array<{ id: string; permissions: string }>,
    dbDiscordIds: Set<string>,
): string[] {
    const eligible = userGuilds
        .filter(ug => dbDiscordIds.has(ug.id) && canManageDiscordServer(String(ug.permissions)))
        .map(ug => ug.id);
    return [...new Set(eligible)].sort();
}

/** Guilds JWT may access — supports legacy tokens with only `guildId`. */
function jwtEligibleDiscordGuilds(decoded: DashboardJwtPayload): string[] {
    if (Array.isArray(decoded.eligibleGuildIds) && decoded.eligibleGuildIds.length) {
        const ids = decoded.eligibleGuildIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim());
        return [...new Set(ids)];
    }
    const g = decoded.guildId;
    return typeof g === 'string' && g.trim() ? [g.trim()] : [];
}

/** Raw guild list from JWT payload for `/auth/me` (may be empty; never recomputed from Discord). */
function jwtRawEligibleFromToken(decoded: DashboardJwtPayload): string[] {
    if (Array.isArray(decoded.eligibleGuildIds)) {
        const ids = decoded.eligibleGuildIds
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim());
        return [...new Set(ids)];
    }
    const g = decoded.guildId;
    return typeof g === 'string' && g.trim() ? [g.trim()] : [];
}

const GIT_SHA =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.RAILWAY_GIT_COMMIT ||
    process.env.RAILWAY_GIT_SHA ||
    process.env.SOURCE_COMMIT ||
    'unknown';

/**
 * HTTPS origin of this API as seen by browsers (no path, no trailing slash).
 * Used for Discord OAuth redirect_uri. Prefer PUBLIC_API_URL; VITE_API_URL is a legacy alias
 * shared with the dashboard build; on Railway, RAILWAY_PUBLIC_DOMAIN is a last-resort fallback.
 */
function normalizePublicApiOrigin(): string | null {
    const explicit = (process.env.PUBLIC_API_URL || process.env.VITE_API_URL || '').trim();
    const railwayDomain = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
    let raw = explicit;
    if (!raw && railwayDomain) {
        raw = `https://${railwayDomain}`;
    }
    if (!raw) {
        console.error(
            '[Auth] OAuth misconfigured: set PUBLIC_API_URL (or VITE_API_URL) to the public API origin (https://host, no trailing path).',
        );
        return null;
    }
    raw = raw.replace(/\/+$/, '');
    if (/^http:\/\//i.test(raw)) {
        raw = `https://${raw.slice('http://'.length)}`;
    }
    if (!/^https:\/\//i.test(raw)) {
        raw = `https://${raw.replace(/^\/+/, '')}`;
    }
    return raw.replace(/\/+$/, '');
}

function discordOAuthRedirectUri(): string | null {
    const origin = normalizePublicApiOrigin();
    if (!origin) return null;
    return `${origin}/api/v1/auth/discord/callback`;
}

export class AdminAPI {
    private app = express();
    private port = Number(process.env.PORT) || 3000;

    /** Express 5 may type route params as `string | string[]`. */
    private soloRouteParam(req: express.Request, key: string): string | undefined {
        const raw = req.params[key];
        return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
    }

    /** `:id` Discord guild snowflake on `/api/v1/guilds/:id/*`. */
    private guildRouteParam(req: express.Request, res: express.Response): string | null {
        const id = this.soloRouteParam(req, 'id');
        const trimmed = typeof id === 'string' ? id.trim() : '';
        if (!trimmed) {
            res.status(400).json({ error: 'Invalid guild id' });
            return null;
        }
        return trimmed;
    }

    /** Require Bearer JWT listing this Discord guild in `eligibleGuildIds` (or legacy single `guildId`). */
    private requireGuildAccess(req: express.Request, res: express.Response, discordGuildId: string): boolean {
        try {
            const normalizedRoute = discordGuildId.trim();
            const authHeader = req.headers.authorization;
            if (!authHeader?.startsWith('Bearer ')) {
                console.warn('[AuthMW] deny reason=no_bearer', { path: req.path, requested: normalizedRoute });
                res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED', status: 401 });
                return false;
            }
            const token = authHeader.split(' ')[1];
            const secret = process.env.JWT_SECRET || 'super_secret_jwt_key';
            const decoded = jwt.verify(token, secret) as DashboardJwtPayload;
            const eligible = jwtEligibleDiscordGuilds(decoded);
            const tokenGuild = typeof decoded.guildId === 'string' ? decoded.guildId.trim() : undefined;
            if (!eligible.length) {
                console.warn('[AuthMW] deny reason=no_eligible_in_token', {
                    requested: normalizedRoute,
                    tokenGuildId: tokenGuild ?? null,
                    tokenEligibleGuildIds: [],
                    discordUserId: decoded.id ?? null,
                });
                res.status(403).json({
                    error: 'Your session no longer has access to this server. Sign out and sign in again.',
                    code: 'GUILD_ACCESS_DENIED',
                    status: 403,
                });
                return false;
            }
            if (!eligible.includes(normalizedRoute)) {
                console.warn('[AuthMW] deny reason=guild_not_in_eligible_list', {
                    requested: normalizedRoute,
                    tokenGuildId: tokenGuild ?? null,
                    tokenEligibleGuildIds: eligible,
                    discordUserId: decoded.id ?? null,
                });
                res.status(403).json({
                    error: 'Your session no longer has access to this server. Sign out and sign in again.',
                    code: 'GUILD_ACCESS_DENIED',
                    status: 403,
                });
                return false;
            }
            return true;
        } catch {
            console.warn('[AuthMW] deny reason=invalid_jwt', { path: req.path, requested: discordGuildId.trim() });
            res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN', status: 401 });
            return false;
        }
    }

    constructor() {
        this.app.use((req, res, next) => {
            console.log(`[API] ${req.method} ${req.url}`);
            next();
        });
        this.app.use(
            cors({
                origin: true,
                methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
                allowedHeaders: ['Content-Type', 'Authorization'],
            }),
        );
        this.app.use(helmet());
        this.app.use(express.json());

        this.setupRoutes();
    }

    private setupRoutes() {
        // 1. Basic Health Check
        this.app.get('/api/health', (req, res) => {
            res.json({ status: 'ok', service: 'superbot-api' });
        });

        this.app.get('/api/version', (_req, res) => {
            res.json({ gitSha: GIT_SHA, node: process.version, service: 'superbot-backend' });
        });

        // 2. Discord OAuth Login Redirect
        const discordOAuthStart = (_req: express.Request, res: express.Response) => {
            const clientId = process.env.DISCORD_CLIENT_ID?.trim();
            if (!clientId) {
                console.error('[Auth] DISCORD_CLIENT_ID is not set');
                return res.status(503).json({ error: 'OAuth not configured', code: 'OAUTH_NOT_CONFIGURED', status: 503 });
            }
            const redirectUriFull = discordOAuthRedirectUri();
            if (!redirectUriFull) {
                return res.status(503).json({ error: 'OAuth not configured', code: 'OAUTH_NOT_CONFIGURED', status: 503 });
            }
            const redirectUri = encodeURIComponent(redirectUriFull);
            const scope = encodeURIComponent('identify guilds');
            const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(
                clientId,
            )}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
            console.log(`[Auth] Redirecting to Discord redirect_uri=${redirectUriFull}`);
            res.redirect(authUrl);
        };
        this.app.get('/api/v1/auth/discord', discordOAuthStart);
        this.app.get('/api/v1/auth/discord/login', discordOAuthStart);

        // 3. Discord OAuth Callback
        this.app.get('/api/v1/auth/discord/callback', async (req, res) => {
            const code = req.query.code as string;
            if (!code) return res.status(400).send('No code provided');

            try {
                const redirectUriFull = discordOAuthRedirectUri();
                if (!redirectUriFull) {
                    return res.status(503).send('Authentication service misconfigured');
                }
                // 1. Exchange code for token
                const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
                    client_id: process.env.DISCORD_CLIENT_ID!,
                    client_secret: process.env.DISCORD_CLIENT_SECRET!,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUriFull,
                }).toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                const { access_token } = tokenResponse.data;

                // 2. Fetch user data
                const userResponse = await axios.get('https://discord.com/api/users/@me', {
                    headers: { Authorization: `Bearer ${access_token}` }
                });

                // 3. Fetch user's guilds to find where the bot is installed and user is admin
                const guildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
                    headers: { Authorization: `Bearer ${access_token}` }
                });

                const userGuilds = guildsResponse.data as Array<{ id: string; permissions: string }>;
                const dbGuilds = await prisma.guild.findMany({
                    where: { discordId: { in: userGuilds.map((g) => g.id) } }
                });

                const dbDiscordIds = new Set(dbGuilds.map(dg => dg.discordId));
                const eligibleGuildIds = discordGuildsEligibleForJwt(userGuilds, dbDiscordIds);
                const dashboardBase = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');

                if (!eligibleGuildIds.length) {
                    console.warn(`[Auth] User ${userResponse.data.username} has no guild with Manage Server/admin in linked SuperBot servers.`);
                    return res.redirect(`${dashboardBase}?auth_error=no_eligible_guild`);
                }

                const rawGid = req.query.guild_id;
                const preferredDiscordId =
                    typeof rawGid === 'string' ? rawGid : Array.isArray(rawGid) ? rawGid[0] : undefined;
                const primaryGuildId =
                    typeof preferredDiscordId === 'string' && eligibleGuildIds.includes(preferredDiscordId)
                        ? preferredDiscordId
                        : eligibleGuildIds[0];

                console.log(
                    `[Auth] Pre-sign JWT user=${userResponse.data.username} discordUserId=${userResponse.data.id} primaryGuildId=${primaryGuildId} eligibleGuildIds=[${eligibleGuildIds.join(', ')}]`,
                );

                // 4. Issue JWT (never omit guild scope — avoids blank dashboard after middleware tightened)
                const jwtToken = jwt.sign(
                    {
                        id: userResponse.data.id,
                        username: userResponse.data.username,
                        guildId: primaryGuildId,
                        eligibleGuildIds,
                        authSchemaVersion: AUTH_SCHEMA_VERSION,
                    },
                    process.env.JWT_SECRET || 'super_secret_jwt_key',
                    { expiresIn: '1d' },
                );

                console.log(
                    `[Auth] Issued JWT gitSha=${GIT_SHA} user=${userResponse.data.username} eligibleGuildIds count=${eligibleGuildIds.length}`,
                );

                res.redirect(`${dashboardBase}?token=${jwtToken}`);
            } catch (error) {
                console.error('[Auth] Discord OAuth Error:', error);
                res.status(500).send('Authentication failed');
            }
        });

        // 2.5 Get Current Session
        this.app.get('/api/v1/auth/me', async (req, res) => {
            try {
                const authHeader = req.headers.authorization;
                if (!authHeader)
                    return res.status(401).json({ error: 'No token', code: 'NO_TOKEN', status: 401 });
                const token = authHeader.split(' ')[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key') as DashboardJwtPayload &
                    JwtTimingFields;

                const rawEligible = jwtRawEligibleFromToken(decoded);
                const trimmedPreferred = typeof decoded.guildId === 'string' ? decoded.guildId.trim() : '';
                const guildId =
                    rawEligible.length > 0
                        ? trimmedPreferred && rawEligible.includes(trimmedPreferred)
                            ? trimmedPreferred
                            : rawEligible[0]!
                        : trimmedPreferred || null;

                const authVer = typeof decoded.authSchemaVersion === 'number' ? decoded.authSchemaVersion : 0;
                const requiresReauth = authVer < AUTH_SCHEMA_VERSION;

                let eligibleGuildSummaries: { id: string; name: string }[] = [];
                if (rawEligible.length > 0) {
                    try {
                        const rows = await prisma.guild.findMany({
                            where: { discordId: { in: rawEligible } },
                            select: { discordId: true, name: true },
                        });
                        const byId = new Map(rows.map((r) => [r.discordId, r.name]));
                        eligibleGuildSummaries = rawEligible.map((id) => ({
                            id,
                            name: byId.get(id) ?? `Server ${id.slice(0, 8)}…`,
                        }));
                    } catch {
                        eligibleGuildSummaries = rawEligible.map((id) => ({ id, name: id }));
                    }
                }

                res.json({
                    userId: decoded.id ?? null,
                    username: decoded.username ?? null,
                    guildId,
                    eligibleGuildIds: rawEligible,
                    eligibleGuildSummaries,
                    jwtIssuedAt:
                        typeof decoded.iat === 'number' ? new Date(decoded.iat * 1000).toISOString() : null,
                    gitSha: GIT_SHA,
                    requiresReauth,
                });
            } catch {
                res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN', status: 401 });
            }
        });

        /** Optional JWT claims inspector (enable with DEBUG_AUTH=true on the API). */
        this.app.get('/api/v1/auth/me-debug', async (req, res) => {
            if (!['1', 'true', 'yes'].includes(String(process.env.DEBUG_AUTH ?? '').toLowerCase())) {
                return res.status(404).json({ error: 'Not found' });
            }
            try {
                const authHeader = req.headers.authorization;
                if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
                const token = authHeader.slice('Bearer '.length).trim();
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key') as DashboardJwtPayload & {
                    exp?: number;
                    iat?: number;
                };
                res.json({
                    discordUserId: decoded.id ?? null,
                    username: decoded.username ?? null,
                    guildId: decoded.guildId ?? null,
                    eligibleGuildIds: Array.isArray(decoded.eligibleGuildIds) ? decoded.eligibleGuildIds : [],
                    exp: typeof decoded.exp === 'number' ? decoded.exp : null,
                    iat: typeof decoded.iat === 'number' ? decoded.iat : null,
                    gitSha: GIT_SHA,
                });
            } catch {
                res.status(401).json({ error: 'Invalid token' });
            }
        });

        // 2.6 Stateless logout — dashboard clears client storage (no session store today)
        this.app.post('/api/v1/auth/logout', (_req, res) => {
            res.status(204).send();
        });

        // 3. Get Guild Alert Channels
        this.app.get('/api/v1/guilds/:id/rules', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.json({ rules: [] });

                const channels = await prisma.alertChannel.findMany({ where: { guildId: guild.id } });
                const wallets  = await prisma.trackedWallet.findMany({ where: { guildId: guild.id } });
                const collections = await prisma.trackedCollection.findMany({ where: { guildId: guild.id } });

                // Map to a unified rules format for the frontend
                const rules = [
                    ...channels.map(c => ({ id: c.id, type: c.alertType, target: 'Global', channelId: c.discordChannelId, status: 'Active', signals: 0 })),
                    ...wallets.map(w => ({ id: w.id, type: 'WHALE_BUY', target: w.address, channelId: w.alertChannelId ?? '—', status: 'Active', signals: 0 })),
                    ...collections.map(col => ({ id: col.id, type: 'COLLECTION_TRACK', target: col.name, channelId: col.alertChannelId ?? '—', status: 'Active', signals: 0 })),
                ];
                res.json({ rules });
            } catch (error) {
                res.status(500).json({ error: 'Database query failed' });
            }
        });

        // 4. Add a tracked wallet via API
        this.app.post('/api/v1/guilds/:id/wallets', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const { address, label, alertChannelId } = req.body;
                const normalized = parseEthAddress(address);
                if (!normalized) {
                    return res.status(400).json({ error: 'Invalid wallet address (expected 0x + 40 hex chars)' });
                }
                const channelOk = alertChannelId == null || alertChannelId === '' || parseSnowflake(alertChannelId);
                if (!channelOk) {
                    return res.status(400).json({ error: 'alertChannelId must be a numeric Discord channel id' });
                }
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                const wallet = await prisma.trackedWallet.upsert({
                    where: { address_guildId: { address: normalized, guildId: guild.id } },
                    create: {
                        guildId: guild.id,
                        address: normalized,
                        label,
                        alertChannelId: alertChannelId ? String(alertChannelId).trim() : null,
                    },
                    update: {
                        label,
                        alertChannelId: alertChannelId ? String(alertChannelId).trim() : null,
                    },
                });
                res.json({ success: true, wallet });
            } catch (error) {
                res.status(500).json({ error: 'Failed to track wallet' });
            }
        });

        // 5. Get tracked wallets
        this.app.get('/api/v1/guilds/:id/wallets', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.json({ wallets: [] });
                const wallets = await prisma.trackedWallet.findMany({ where: { guildId: guild.id } });
                res.json({ wallets });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch wallets' });
            }
        });

        // 5b. Delete a tracked wallet
        this.app.delete('/api/v1/guilds/:id/wallets/:walletId', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const walletId = this.soloRouteParam(req, 'walletId');
                if (!walletId) return res.status(400).json({ error: 'Invalid wallet id' });
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                await prisma.trackedWallet.deleteMany({
                    where: { id: walletId, guildId: guild.id }
                });
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: 'Failed to delete wallet' });
            }
        });

        // 6. Get tracked collections
        this.app.get('/api/v1/guilds/:id/collections', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.json({ collections: [] });
                const collections = await prisma.trackedCollection.findMany({ where: { guildId: guild.id } });
                res.json({ collections });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch collections' });
            }
        });

        // 6b. Add a tracked collection
        this.app.post('/api/v1/guilds/:id/collections', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const { contract, name, floorAlertPct, alertChannelId } = req.body;
                const contractNorm = parseEthAddress(contract);
                if (!contractNorm) {
                    return res.status(400).json({ error: 'Invalid contract address (expected 0x + 40 hex chars)' });
                }
                if (typeof name !== 'string' || !name.trim()) {
                    return res.status(400).json({ error: 'Collection name is required' });
                }
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                const collection = await prisma.trackedCollection.upsert({
                    where: { contractAddress_guildId: { contractAddress: contractNorm, guildId: guild.id } },
                    create: {
                        guildId: guild.id,
                        contractAddress: contractNorm,
                        name: name.trim(),
                        floorAlertPct: floorAlertPct ?? null,
                        alertChannelId: alertChannelId ? String(alertChannelId).trim() : null,
                    },
                    update: { name: name.trim(), floorAlertPct: floorAlertPct ?? null },
                });
                res.json({ success: true, collection });
            } catch (error) {
                res.status(500).json({ error: 'Failed to track collection' });
            }
        });

        // 7. Delete a tracked collection
        this.app.delete('/api/v1/guilds/:id/collections/:collectionId', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const collectionId = this.soloRouteParam(req, 'collectionId');
                if (!collectionId) return res.status(400).json({ error: 'Invalid collection id' });
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                await prisma.trackedCollection.deleteMany({
                    where: { id: collectionId, guildId: guild.id }
                });
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: 'Failed to delete collection' });
            }
        });

        // 8. Guild status summary
        this.app.get('/api/v1/guilds/:id/status', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const guild = await prisma.guild.findUnique({
                    where: { discordId: discordGuildId },
                    include: { alertChannels: true, trackedWallets: true, trackedCollections: true }
                });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });
                res.json({
                    plan: guild.planTier,
                    channels: guild.alertChannels.length,
                    wallets: guild.trackedWallets.length,
                    collections: guild.trackedCollections.length,
                });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch status' });
            }
        });

        // 9. Get User Settings (Sniper & Wallet)
        this.app.get('/api/v1/user/settings', async (req, res) => {
            try {
                const authHeader = req.headers.authorization;
                if (!authHeader) return res.status(401).json({ error: 'No token' });
                const token = authHeader.split(' ')[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key') as any;
                
                const user = await prisma.user.findUnique({ where: { discordId: decoded.id } });
                if (!user) return res.json({ autoMint: false, maxPrice: 0.1, gasBuffer: 5.0, wallet: null });
                
                res.json({
                    autoMint: user.autoMintEnabled,
                    maxPrice: user.maxMintPrice,
                    gasBuffer: user.gasBufferGwei,
                    wallet: user.walletAddress
                });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch user settings' });
            }
        });

        // 10. Update User Settings
        this.app.post('/api/v1/user/settings', async (req, res) => {
            try {
                const authHeader = req.headers.authorization;
                if (!authHeader) return res.status(401).json({ error: 'No token' });
                const token = authHeader.split(' ')[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key') as any;
                
                const { autoMint, maxPrice, gasBuffer } = req.body;
                
                const updated = await prisma.user.upsert({
                    where: { discordId: decoded.id },
                    create: { 
                        discordId: decoded.id, 
                        autoMintEnabled: autoMint, 
                        maxMintPrice: maxPrice, 
                        gasBufferGwei: gasBuffer 
                    },
                    update: { 
                        autoMintEnabled: autoMint, 
                        maxMintPrice: maxPrice, 
                        gasBufferGwei: gasBuffer 
                    }
                });
                
                res.json({ success: true, user: updated });
            } catch (error) {
                res.status(500).json({ error: 'Failed to update user settings' });
            }
        });

        // Guild analytics (AlertDeliveryLog scoped to this guild's Discord channel snowflakes)
        this.app.get('/api/v1/guilds/:id/stats', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const internalId = await prismaGuildInternalIdOr404(discordGuildId, res);
                if (!internalId) return;
                const guild = await prisma.guild.findUnique({
                    where: { id: internalId },
                    include: { trackedWallets: true, trackedCollections: true, alertChannels: true },
                });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });
                const channelIds = await collectGuildDeliveryDiscordChannelIds(internalId);
                const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const startUtcDay = new Date();
                startUtcDay.setUTCHours(0, 0, 0, 0);

                const alertsLast24h =
                    channelIds.length > 0
                        ? await prisma.alertDeliveryLog.count({
                              where: {
                                  channelId: { in: channelIds },
                                  createdAt: { gte: since24 },
                                  status: 'delivered',
                              },
                          })
                        : 0;

                const typeGroups =
                    channelIds.length > 0
                        ? await prisma.alertDeliveryLog.groupBy({
                              by: ['alertType'],
                              where: {
                                  channelId: { in: channelIds },
                                  createdAt: { gte: startUtcDay },
                                  status: 'delivered',
                              },
                              _count: { _all: true },
                          })
                        : [];

                res.json({
                    wallets: guild.trackedWallets.length,
                    collections: guild.trackedCollections.length,
                    alertsLast24h,
                    deliveredTodayByType: Object.fromEntries(
                        typeGroups.map((g) => [g.alertType, g._count._all]),
                    ),
                });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch guild stats' });
            }
        });

        this.app.get('/api/v1/guilds/:id/recent-alerts', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const internalId = await prismaGuildInternalIdOr404(discordGuildId, res);
                if (!internalId) return;
                const channelIds = await collectGuildDeliveryDiscordChannelIds(internalId);
                if (channelIds.length === 0) {
                    return res.json({ items: [] });
                }
                const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const items = await prisma.alertDeliveryLog.findMany({
                    where: { channelId: { in: channelIds }, createdAt: { gte: since24 } },
                    orderBy: { createdAt: 'desc' },
                    take: 20,
                    select: {
                        id: true,
                        alertType: true,
                        status: true,
                        channelId: true,
                        eventId: true,
                        createdAt: true,
                        error: true,
                    },
                });
                res.json({ items });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch recent alerts' });
            }
        });

        this.app.patch('/api/v1/guilds/:id/collections/:collectionId', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const collectionId = this.soloRouteParam(req, 'collectionId');
                if (!collectionId) return res.status(400).json({ error: 'Invalid collection id' });
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });
                const existing = await prisma.trackedCollection.findFirst({
                    where: { id: collectionId, guildId: guild.id },
                });
                if (!existing) return res.status(404).json({ error: 'Collection not found' });

                const body = req.body as Record<string, unknown>;
                const data: Record<string, unknown> = {};

                if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();

                const numOrNull = (v: unknown): number | null | undefined => {
                    if (v === undefined) return undefined;
                    if (v === null) return null;
                    const n = Number(v);
                    return Number.isFinite(n) ? n : undefined;
                };

                const optNum = (key: string) => {
                    if (!(key in body)) return;
                    const v = numOrNull(body[key]);
                    if (v !== undefined) data[key] = v;
                };

                optNum('floorAlertPct');
                optNum('floorRiseAlertPct');
                optNum('sweepThresholdNative');
                optNum('massListingThreshold');

                if (typeof body.hotMintEnabled === 'boolean') data.hotMintEnabled = body.hotMintEnabled;
                if (typeof body.delistAlertEnabled === 'boolean')
                    data.delistAlertEnabled = body.delistAlertEnabled;

                if ('hotMintChannelId' in body) {
                    const raw = body.hotMintChannelId;
                    if (raw === null || raw === '') data.hotMintChannelId = null;
                    else {
                        const ch = parseSnowflake(raw);
                        if (!ch) {
                            return res.status(400).json({ error: 'hotMintChannelId must be a Discord channel id' });
                        }
                        data.hotMintChannelId = ch;
                    }
                }
                if ('delistChannelId' in body) {
                    const raw = body.delistChannelId;
                    if (raw === null || raw === '') data.delistChannelId = null;
                    else {
                        const ch = parseSnowflake(raw);
                        if (!ch) {
                            return res.status(400).json({ error: 'delistChannelId must be a Discord channel id' });
                        }
                        data.delistChannelId = ch;
                    }
                }
                if ('alertChannelId' in body) {
                    const raw = body.alertChannelId;
                    if (raw === null || raw === '') data.alertChannelId = null;
                    else {
                        const ch = parseSnowflake(raw);
                        if (!ch) {
                            return res.status(400).json({ error: 'alertChannelId must be a Discord channel id' });
                        }
                        data.alertChannelId = ch;
                    }
                }

                if ('mentionRoleId' in body) {
                    const raw = body.mentionRoleId;
                    if (raw === null || raw === '') data.mentionRoleId = null;
                    else {
                        const role = parseSnowflake(raw);
                        if (!role) {
                            return res.status(400).json({ error: 'mentionRoleId must be a Discord role id' });
                        }
                        data.mentionRoleId = role;
                    }
                }

                if (Object.keys(data).length === 0) {
                    return res.status(400).json({ error: 'No valid fields to update' });
                }

                const collection = await prisma.trackedCollection.update({
                    where: { id: existing.id },
                    data: data as any,
                });
                res.json({ success: true, collection });
            } catch (error) {
                res.status(500).json({ error: 'Failed to update collection' });
            }
        });

        this.app.get('/api/v1/guilds/:id/alert-channels', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });
                const channels = await prisma.alertChannel.findMany({
                    where: { guildId: guild.id },
                    orderBy: { alertType: 'asc' },
                });
                res.json({ channels });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch alert channels' });
            }
        });

        this.app.put('/api/v1/guilds/:id/alert-channels/:alertType', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const rawType = this.soloRouteParam(req, 'alertType');
                const alertType = decodeURIComponent(String(rawType ?? '')).trim().toUpperCase();
                if (!ALERT_TYPE_PARAM_RE.test(alertType)) {
                    return res.status(400).json({ error: 'Invalid alert type' });
                }
                const discordChannelId = parseSnowflake(req.body?.discordChannelId);
                if (!discordChannelId) {
                    return res.status(400).json({ error: 'discordChannelId is required (numeric Discord channel id)' });
                }

                let mentionRoleId: string | null | undefined = undefined;
                if ('mentionRoleId' in req.body) {
                    const raw = (req.body as any).mentionRoleId;
                    if (raw === null || raw === '') mentionRoleId = null;
                    else {
                        const p = parseSnowflake(raw);
                        if (!p)
                            return res.status(400).json({ error: 'mentionRoleId must be a numeric Discord role id' });
                        mentionRoleId = p;
                    }
                }

                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                const nm =
                    typeof (req.body as any)?.name === 'string' && String((req.body as any).name).trim().length > 0
                        ? String((req.body as any).name).trim()
                        : alertType;

                const row = await prisma.alertChannel.upsert({
                    where: { guildId_alertType: { guildId: guild.id, alertType } },
                    create: {
                        guildId: guild.id,
                        discordChannelId,
                        name: nm,
                        alertType,
                        mentionRoleId:
                            mentionRoleId === undefined
                                ? null
                                : (mentionRoleId as string | null),
                    },
                    update: {
                        discordChannelId,
                        name: nm,
                        ...(mentionRoleId !== undefined ? { mentionRoleId } : {}),
                    },
                });

                res.json({ success: true, channel: row });
            } catch (error) {
                res.status(500).json({ error: 'Failed to save alert channel' });
            }
        });

        this.app.delete('/api/v1/guilds/:id/alert-channels/:alertType', async (req, res) => {
            const discordGuildId = this.guildRouteParam(req, res);
            if (!discordGuildId) return;
            if (!this.requireGuildAccess(req, res, discordGuildId)) return;
            try {
                const rawType = this.soloRouteParam(req, 'alertType');
                const alertType = decodeURIComponent(String(rawType ?? '')).trim().toUpperCase();
                if (!ALERT_TYPE_PARAM_RE.test(alertType)) {
                    return res.status(400).json({ error: 'Invalid alert type' });
                }
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });
                await prisma.alertChannel.deleteMany({ where: { guildId: guild.id, alertType } });
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: 'Failed to delete alert channel route' });
            }
        });

        this.app.get('/api/v1/watchlist', async (req, res) => {
            const discordUserId = decodeJwtDiscordUserId(req);
            if (!discordUserId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED', status: 401 });
            try {
                const user = await prisma.user.findUnique({
                    where: { discordId: discordUserId },
                    include: { watchlists: { orderBy: { createdAt: 'desc' } } },
                });
                res.json({ items: user?.watchlists ?? [] });
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch watchlist' });
            }
        });

        this.app.post('/api/v1/watchlist', async (req, res) => {
            const discordUserId = decodeJwtDiscordUserId(req);
            if (!discordUserId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED', status: 401 });
            try {
                const { targetType, targetAddress } = req.body as { targetType?: string; targetAddress?: string };
                const tt = typeof targetType === 'string' ? targetType.trim().toLowerCase() : '';
                if (tt !== 'wallet' && tt !== 'collection') {
                    return res.status(400).json({ error: 'targetType must be wallet or collection' });
                }
                const addrRaw = typeof targetAddress === 'string' ? targetAddress.trim() : '';
                const addrNorm = parseEthAddress(addrRaw);
                if (!addrNorm) {
                    return res.status(400).json({ error: 'targetAddress must be a valid 0x address' });
                }
                const user = await prisma.user.upsert({
                    where: { discordId: discordUserId },
                    create: { discordId: discordUserId },
                    update: {},
                });
                await prisma.watchlist.upsert({
                    where: {
                        userId_targetType_targetAddress: {
                            userId: user.id,
                            targetType: tt,
                            targetAddress: addrNorm,
                        },
                    },
                    create: {
                        userId: user.id,
                        targetType: tt,
                        targetAddress: addrNorm,
                    },
                    update: {},
                });
                const rows = await prisma.watchlist.findMany({
                    where: { userId: user.id },
                    orderBy: { createdAt: 'desc' },
                });
                const created = rows.find((w) => w.targetType === tt && w.targetAddress === addrNorm);
                res.json({ success: true, item: created ?? null });
            } catch (error) {
                res.status(500).json({ error: 'Failed to add watchlist entry' });
            }
        });

        this.app.delete('/api/v1/watchlist/:itemId', async (req, res) => {
            const discordUserId = decodeJwtDiscordUserId(req);
            if (!discordUserId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED', status: 401 });
            try {
                const itemId = this.soloRouteParam(req, 'itemId');
                if (!itemId) return res.status(400).json({ error: 'Invalid watchlist item id' });
                const user = await prisma.user.findUnique({ where: { discordId: discordUserId } });
                if (!user) return res.json({ success: true });
                await prisma.watchlist.deleteMany({ where: { id: itemId, userId: user.id } });
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: 'Failed to remove watchlist item' });
            }
        });

        // Unknown `/api/*` — always JSON (avoids Express default HTML/plain bodies on 404)
        this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
            if (req.path.startsWith('/api')) {
                res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', status: 404 });
                return;
            }
            next();
        });

        this.app.use(
            (
                err: unknown,
                _req: express.Request,
                res: express.Response,
                _next: express.NextFunction,
            ) => {
                if (res.headersSent) return;
                console.error('[API] Unhandled error', err);
                const message = err instanceof Error ? err.message : 'Internal server error';
                res.status(500).json({ error: message, code: 'INTERNAL_ERROR', status: 500 });
            },
        );
    }

    public start() {
        this.app.listen(Number(this.port), '0.0.0.0', () => {
            console.log(`🌐 Admin API Dashboard Server listening on port ${this.port}`);
        });
    }
}

if (require.main === module) {
    const api = new AdminAPI();
    api.start();
}
