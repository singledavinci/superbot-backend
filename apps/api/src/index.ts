import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as dotenv from 'dotenv';
import { prisma } from '@superbot/database';
import jwt from 'jsonwebtoken';
import axios from 'axios';

dotenv.config();

interface DashboardJwtPayload {
    id?: string;
    username?: string;
    /** Preferred guild (Discord snowflake). */
    guildId?: string;
    /** Discord snowflakes where the user may access SuperBot guild routes (staff of that server). */
    eligibleGuildIds?: string[];
}

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

const GIT_SHA =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.RAILWAY_GIT_COMMIT ||
    process.env.RAILWAY_GIT_SHA ||
    process.env.SOURCE_COMMIT ||
    'unknown';

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
                res.status(401).json({ error: 'Unauthorized' });
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
                res.status(403).json({ error: 'Session has no allowed servers — sign out and sign in again.' });
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
                    error:
                        'You do not have dashboard access for this Discord server ID. Pick your server from the header dropdown or ensure the bot was added (Guild row synced) and try again.',
                });
                return false;
            }
            return true;
        } catch {
            console.warn('[AuthMW] deny reason=invalid_jwt', { path: req.path, requested: discordGuildId.trim() });
            res.status(401).json({ error: 'Invalid token' });
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
        this.app.get('/api/v1/auth/discord', (req, res) => {
            const clientId = process.env.DISCORD_CLIENT_ID;
            const apiUrl = (process.env.VITE_API_URL || '').replace(/\/$/, '');
            const redirectUri = encodeURIComponent(`${apiUrl}/api/v1/auth/discord/callback`);
            const scope = 'identify guilds';
            const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
            console.log(`[Auth] Redirecting to Discord with URI: ${apiUrl}/api/v1/auth/discord/callback`);
            res.redirect(authUrl);
        });

        // 3. Discord OAuth Callback
        this.app.get('/api/v1/auth/discord/callback', async (req, res) => {
            const code = req.query.code as string;
            if (!code) return res.status(400).send('No code provided');

            try {
                const apiUrl = (process.env.VITE_API_URL || '').replace(/\/$/, '');
                // 1. Exchange code for token
                const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
                    client_id: process.env.DISCORD_CLIENT_ID!,
                    client_secret: process.env.DISCORD_CLIENT_SECRET!,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: `${apiUrl}/api/v1/auth/discord/callback`
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
                    },
                    process.env.JWT_SECRET || 'super_secret_jwt_key',
                    { expiresIn: '1d' },
                );

                console.log(`[Auth] Issued JWT for ${userResponse.data.username} eligibleGuildIds count=${eligibleGuildIds.length}`);

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
                if (!authHeader) return res.status(401).json({ error: 'No token' });
                const token = authHeader.split(' ')[1];
                const decoded = jwt.verify(
                    token,
                    process.env.JWT_SECRET || 'super_secret_jwt_key',
                ) as DashboardJwtPayload;
                const eligible = jwtEligibleDiscordGuilds(decoded);
                if (!eligible.length) {
                    return res.status(401).json({ error: 'Token missing guild scope; sign in again.' });
                }
                const rawG = decoded.guildId;
                const trimmedG = typeof rawG === 'string' ? rawG.trim() : undefined;
                const guildId = trimmedG && eligible.includes(trimmedG) ? trimmedG : eligible[0];
                res.json({
                    guildId,
                    eligibleGuildIds: eligible,
                    id: decoded.id,
                    username: decoded.username,
                });
            } catch (error) {
                res.status(401).json({ error: 'Invalid token' });
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
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                const wallet = await prisma.trackedWallet.upsert({
                    where: { address_guildId: { address: address.toLowerCase(), guildId: guild.id } },
                    create: { guildId: guild.id, address: address.toLowerCase(), label, alertChannelId },
                    update: { label, alertChannelId }
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
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                const collection = await prisma.trackedCollection.upsert({
                    where: { contractAddress_guildId: { contractAddress: contract.toLowerCase(), guildId: guild.id } },
                    create: { guildId: guild.id, contractAddress: contract.toLowerCase(), name, floorAlertPct: floorAlertPct ?? null, alertChannelId: alertChannelId ?? null },
                    update: { name, floorAlertPct: floorAlertPct ?? null }
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
