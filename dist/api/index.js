"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminAPI = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const dotenv = __importStar(require("dotenv"));
const db_1 = require("../db");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const axios_1 = __importDefault(require("axios"));
dotenv.config();
class AdminAPI {
    app = (0, express_1.default)();
    port = process.env.PORT || 3000;
    constructor() {
        this.app.use((0, cors_1.default)());
        this.app.use((0, helmet_1.default)());
        this.app.use(express_1.default.json());
        this.setupRoutes();
    }
    setupRoutes() {
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
            const code = req.query.code;
            if (!code)
                return res.status(400).send('No code provided');
            try {
                // Exchange code for token
                const tokenResponse = await axios_1.default.post('https://discord.com/api/oauth2/token', new URLSearchParams({
                    client_id: process.env.DISCORD_CLIENT_ID,
                    client_secret: process.env.DISCORD_CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: `${process.env.DASHBOARD_URL}/api/v1/auth/discord/callback`
                }).toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });
                const { access_token } = tokenResponse.data;
                // Fetch user data
                const userResponse = await axios_1.default.get('https://discord.com/api/users/@me', {
                    headers: { Authorization: `Bearer ${access_token}` }
                });
                // Issue JWT to frontend
                const jwtToken = jsonwebtoken_1.default.sign({ id: userResponse.data.id, username: userResponse.data.username }, process.env.JWT_SECRET || 'super_secret_jwt_key', { expiresIn: '1d' });
                // Redirect back to frontend with token
                res.redirect(`${process.env.DASHBOARD_URL}?token=${jwtToken}`);
            }
            catch (error) {
                console.error('[Auth] Discord OAuth Error:', error);
                res.status(500).send('Authentication failed');
            }
        });
        // 3. Get Guild Alert Channels
        this.app.get('/api/v1/guilds/:id/rules', async (req, res) => {
            try {
                const discordGuildId = req.params.id;
                const guild = await db_1.prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild)
                    return res.json({ rules: [] });
                const channels = await db_1.prisma.alertChannel.findMany({ where: { guildId: guild.id } });
                const wallets = await db_1.prisma.trackedWallet.findMany({ where: { guildId: guild.id } });
                const collections = await db_1.prisma.trackedCollection.findMany({ where: { guildId: guild.id } });
                // Map to a unified rules format for the frontend
                const rules = [
                    ...channels.map(c => ({ id: c.id, type: c.alertType, target: 'Global', channelId: c.discordChannelId, status: 'Active', signals: 0 })),
                    ...wallets.map(w => ({ id: w.id, type: 'WHALE_BUY', target: w.address, channelId: w.alertChannelId ?? '—', status: 'Active', signals: 0 })),
                    ...collections.map(col => ({ id: col.id, type: 'COLLECTION_TRACK', target: col.name, channelId: col.alertChannelId ?? '—', status: 'Active', signals: 0 })),
                ];
                res.json({ rules });
            }
            catch (error) {
                res.status(500).json({ error: 'Database query failed' });
            }
        });
        // 4. Add a tracked wallet via API
        this.app.post('/api/v1/guilds/:id/wallets', async (req, res) => {
            try {
                const discordGuildId = req.params.id;
                const { address, label, alertChannelId } = req.body;
                const guild = await db_1.prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild)
                    return res.status(404).json({ error: 'Guild not found' });
                const wallet = await db_1.prisma.trackedWallet.upsert({
                    where: { address_guildId: { address: address.toLowerCase(), guildId: guild.id } },
                    create: { guildId: guild.id, address: address.toLowerCase(), label, alertChannelId },
                    update: { label, alertChannelId }
                });
                res.json({ success: true, wallet });
            }
            catch (error) {
                res.status(500).json({ error: 'Failed to track wallet' });
            }
        });
        // 5. Delete a tracked wallet
        this.app.delete('/api/v1/guilds/:id/wallets/:walletId', async (req, res) => {
            try {
                const discordGuildId = req.params.id;
                const guild = await db_1.prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild)
                    return res.status(404).json({ error: 'Guild not found' });
                await db_1.prisma.trackedWallet.deleteMany({
                    where: { id: req.params.walletId, guildId: guild.id }
                });
                res.json({ success: true });
            }
            catch (error) {
                res.status(500).json({ error: 'Failed to delete wallet' });
            }
        });
        // 6. Add a tracked collection
        this.app.post('/api/v1/guilds/:id/collections', async (req, res) => {
            try {
                const discordGuildId = req.params.id;
                const { contract, name, floorAlertPct, alertChannelId } = req.body;
                const guild = await db_1.prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild)
                    return res.status(404).json({ error: 'Guild not found' });
                const collection = await db_1.prisma.trackedCollection.upsert({
                    where: { contractAddress_guildId: { contractAddress: contract.toLowerCase(), guildId: guild.id } },
                    create: { guildId: guild.id, contractAddress: contract.toLowerCase(), name, floorAlertPct: floorAlertPct ?? null, alertChannelId: alertChannelId ?? null },
                    update: { name, floorAlertPct: floorAlertPct ?? null }
                });
                res.json({ success: true, collection });
            }
            catch (error) {
                res.status(500).json({ error: 'Failed to track collection' });
            }
        });
        // 7. Delete a tracked collection
        this.app.delete('/api/v1/guilds/:id/collections/:collectionId', async (req, res) => {
            try {
                const discordGuildId = req.params.id;
                const guild = await db_1.prisma.guild.findUnique({ where: { discordId: discordGuildId } });
                if (!guild)
                    return res.status(404).json({ error: 'Guild not found' });
                await db_1.prisma.trackedCollection.deleteMany({
                    where: { id: req.params.collectionId, guildId: guild.id }
                });
                res.json({ success: true });
            }
            catch (error) {
                res.status(500).json({ error: 'Failed to delete collection' });
            }
        });
        // 8. Guild status summary
        this.app.get('/api/v1/guilds/:id/status', async (req, res) => {
            try {
                const guild = await db_1.prisma.guild.findUnique({
                    where: { discordId: req.params.id },
                    include: { alertChannels: true, trackedWallets: true, trackedCollections: true }
                });
                if (!guild)
                    return res.status(404).json({ error: 'Guild not found' });
                res.json({
                    plan: guild.planTier,
                    channels: guild.alertChannels.length,
                    wallets: guild.trackedWallets.length,
                    collections: guild.trackedCollections.length,
                });
            }
            catch (error) {
                res.status(500).json({ error: 'Failed to fetch status' });
            }
        });
    }
    start() {
        this.app.listen(this.port, () => {
            console.log(`🌐 Admin API Dashboard Server listening on port ${this.port}`);
        });
    }
}
exports.AdminAPI = AdminAPI;
