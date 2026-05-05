import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as dotenv from 'dotenv';
import { prisma } from '../db';
import jwt from 'jsonwebtoken';
import axios from 'axios';

dotenv.config();

export class AdminAPI {
    private app = express();
    private port = process.env.PORT || 3000;

    constructor() {
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
            const redirectUri = encodeURIComponent(`${process.env.VITE_API_URL}/api/v1/auth/discord/callback`);
            const scope = 'identify guilds';
            const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
            res.redirect(authUrl);
        });

        // 3. Discord OAuth Callback
        this.app.get('/api/v1/auth/discord/callback', async (req, res) => {
            const code = req.query.code as string;
            if (!code) return res.status(400).send('No code provided');

            try {
                // Exchange code for token
                const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
                    client_id: process.env.DISCORD_CLIENT_ID!,
                    client_secret: process.env.DISCORD_CLIENT_SECRET!,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: `${process.env.VITE_API_URL}/api/v1/auth/discord/callback`
                }).toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                const { access_token } = tokenResponse.data;

                // Fetch user data
                const userResponse = await axios.get('https://discord.com/api/users/@me', {
                    headers: { Authorization: `Bearer ${access_token}` }
                });

                // Issue JWT to frontend
                const jwtToken = jwt.sign(
                    { id: userResponse.data.id, username: userResponse.data.username },
                    process.env.JWT_SECRET || 'super_secret_jwt_key',
                    { expiresIn: '1d' }
                );

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
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key') as any;
                res.json({ guildId: decoded.guildId, userId: decoded.userId });
            } catch (error) {
                res.status(401).json({ error: 'Invalid token' });
            }
        });

        // 3. Get Guild Alert Channels
        this.app.get('/api/v1/guilds/:id/rules', async (req, res) => {
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
    }

    public start() {
        this.app.listen(this.port, '0.0.0.0', () => {
            console.log(`🌐 Admin API Dashboard Server listening on port ${this.port}`);
        });
    }
}
