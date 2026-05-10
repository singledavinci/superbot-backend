import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as dotenv from 'dotenv';
import { prisma } from '@superbot/database';
import jwt from 'jsonwebtoken';
import axios from 'axios';

dotenv.config();

export class AdminAPI {
    private app = express();
    private port = Number(process.env.PORT) || 3000;

    /** Require Authorization Bearer JWT whose `guildId` matches `req.params.id` (Discord guild snowflake). */
    private requireGuildAccess(req: express.Request, res: express.Response): boolean {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader?.startsWith('Bearer ')) {
                res.status(401).json({ error: 'Unauthorized' });
                return false;
            }
            const token = authHeader.split(' ')[1];
            const secret = process.env.JWT_SECRET || 'super_secret_jwt_key';
            const decoded = jwt.verify(token, secret) as { guildId?: string };
            if (!decoded.guildId || decoded.guildId !== req.params.id) {
                res.status(403).json({ error: 'Token guild does not match requested guild' });
                return false;
            }
            return true;
        } catch {
            res.status(401).json({ error: 'Invalid token' });
            return false;
        }
    }

    constructor() {
        this.app.use((req, res, next) => {
            console.log(`[API] ${req.method} ${req.url}`);
            next();
        });
        this.app.use(cors());
        this.app.use(helmet());
        this.app.use(express.json());

        this.setupRoutes();
    }

    private setupRoutes() {
        // 1. Basic Health Check
        this.app.get('/api/health', (req, res) => {
            res.json({ status: 'ok', service: 'superbot-api' });
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

                const userGuilds = guildsResponse.data;
                const dbGuilds = await prisma.guild.findMany({
                    where: { discordId: { in: userGuilds.map((g: any) => g.id) } }
                });

                // Pick the first guild that exists in our DB and user has permissions for (optional: check permissions bitwise)
                // MANAGE_GUILD permission is 0x20
                const authorizedGuild = userGuilds.find((ug: any) => 
                    dbGuilds.some(dg => dg.discordId === ug.id) && 
                    (BigInt(ug.permissions) & BigInt(0x20)) === BigInt(0x20)
                );

                const resolvedGuildId = authorizedGuild ? authorizedGuild.id : (req.query.guild_id as string);

                // 4. Issue JWT to frontend
                const jwtToken = jwt.sign(
                    { 
                        id: userResponse.data.id, 
                        username: userResponse.data.username,
                        guildId: resolvedGuildId // Auto-resolved guild
                    },
                    process.env.JWT_SECRET || 'super_secret_jwt_key',
                    { expiresIn: '1d' }
                );

                console.log(`[Auth] User ${userResponse.data.username} logged in. Resolved Guild: ${resolvedGuildId}`);

                // Redirect back to frontend with token
                res.redirect(`${process.env.DASHBOARD_URL}?token=${jwtToken}`);
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
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key') as { id: string, username: string, guildId: string };
                res.json({ guildId: decoded.guildId, id: decoded.id, username: decoded.username });
            } catch (error) {
                res.status(401).json({ error: 'Invalid token' });
            }
        });

        // 3. Get Guild Alert Channels
        this.app.get('/api/v1/guilds/:id/rules', async (req, res) => {
            if (!this.requireGuildAccess(req, res)) return;
            try {
                const discordGuildId = req.params.id;
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
            if (!this.requireGuildAccess(req, res)) return;
            try {
                const discordGuildId = req.params.id;
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
            if (!this.requireGuildAccess(req, res)) return;
            try {
                const discordGuildId = req.params.id;
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
            if (!this.requireGuildAccess(req, res)) return;
            try {
                const discordGuildId = req.params.id;
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                await prisma.trackedWallet.deleteMany({
                    where: { id: req.params.walletId, guildId: guild.id }
                });
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: 'Failed to delete wallet' });
            }
        });

        // 6. Get tracked collections
        this.app.get('/api/v1/guilds/:id/collections', async (req, res) => {
            if (!this.requireGuildAccess(req, res)) return;
            try {
                const discordGuildId = req.params.id;
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
            if (!this.requireGuildAccess(req, res)) return;
            try {
                const discordGuildId = req.params.id;
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
            if (!this.requireGuildAccess(req, res)) return;
            try {
                const discordGuildId = req.params.id;
                const guild = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild) return res.status(404).json({ error: 'Guild not found' });

                await prisma.trackedCollection.deleteMany({
                    where: { id: req.params.collectionId, guildId: guild.id }
                });
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: 'Failed to delete collection' });
            }
        });

        // 8. Guild status summary
        this.app.get('/api/v1/guilds/:id/status', async (req, res) => {
            if (!this.requireGuildAccess(req, res)) return;
            try {
                const guild = await prisma.guild.findUnique({
                    where: { discordId: req.params.id },
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
