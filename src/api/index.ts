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
            const redirectUri = encodeURIComponent(`${process.env.DASHBOARD_URL}/api/v1/auth/discord/callback`);
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
                    redirect_uri: `${process.env.DASHBOARD_URL}/api/v1/auth/discord/callback`
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

        // 3. Get Guild Alert Rules
        this.app.get('/api/v1/guilds/:id/rules', async (req, res) => {
            try {
                const guildId = req.params.id;
                const rules = await prisma.alertRule.findMany({
                    where: { guildId },
                    include: { channel: true, wallet: true, collection: true }
                });
                res.json({ rules });
            } catch (error) {
                res.status(500).json({ error: 'Database query failed' });
            }
        });

        // 4. Create/Update Alert Rule
        this.app.post('/api/v1/guilds/:id/rules', async (req, res) => {
            // Note: Add auth middleware to verify user is Guild Admin
            try {
                const guildId = req.params.id;
                const { channelId, type, targetWalletId, targetCollectionId } = req.body;

                // For MVP, just a raw insert
                const rule = await prisma.alertRule.create({
                    data: {
                        guildId,
                        channelId,
                        type,
                        targetWalletId,
                        targetCollectionId
                    }
                });

                res.json({ success: true, rule });
            } catch (error) {
                res.status(500).json({ error: 'Failed to create rule' });
            }
        });
    }

    public start() {
        this.app.listen(this.port, () => {
            console.log(`🌐 Admin API Dashboard Server listening on port ${this.port}`);
        });
    }
}
