"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventWorker = void 0;
const bullmq_1 = require("bullmq");
const queue_1 = require("../queue");
const db_1 = require("../db");
const intelligence_1 = require("../intelligence");
const profiler_1 = require("../analytics/profiler");
const clickhouse_1 = require("../analytics/clickhouse");
class EventWorker {
    worker;
    contextEngine;
    profiler;
    constructor() {
        this.contextEngine = new intelligence_1.ContextEngine();
        this.profiler = new profiler_1.SmartMoneyProfiler();
        this.worker = new bullmq_1.Worker('blockchain_events', this.processJob.bind(this), {
            connection: queue_1.redisConnection,
            concurrency: 5 // Process 5 events concurrently
        });
        this.worker.on('completed', (job) => {
            // console.log(`[Worker] Job ${job.id} completed`);
        });
        this.worker.on('failed', (job, err) => {
            console.error(`❌ [Worker] Job ${job?.id} failed:`, err);
        });
    }
    start() {
        console.log('👷 Event Worker started listening for blockchain events...');
    }
    async processJob(job) {
        if (job.name === 'nft_transfer') {
            await this.handleNftTransfer(job.data);
        }
    }
    async handleNftTransfer(data) {
        const { eventId, chain, contract, from, to, tokenId, txHash, blockNumber } = data;
        // --- MINT RADAR & ANALYTICS SINK ---
        if (from === '0x0000000000000000000000000000000000000000') {
            await this.handleMintRadar(chain, contract);
            // Push to ClickHouse Analytics
            try {
                await clickhouse_1.clickhouse.insert({
                    table: 'superbot_analytics.mints',
                    values: [{
                            timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
                            chain,
                            contract,
                            to_address: to,
                            token_id: tokenId,
                            tx_hash: txHash
                        }],
                    format: 'JSONEachRow'
                });
            }
            catch (err) {
                console.error('[Analytics] Failed to sink mint event to ClickHouse', err);
            }
        }
        // --- WASH TRADE CHECK ---
        if (this.contextEngine.detectWashTrade(from, to, false)) {
            console.log(`[Worker] Flagged as wash trade, skipping alert: ${txHash}`);
            return;
        }
        // --- WHALE BUY ALERTS ---
        // Find any tracking record across all guilds for this wallet address
        const trackedBuyers = await db_1.prisma.trackedWallet.findMany({
            where: { address: to }
        });
        for (const trackedBuyer of trackedBuyers) {
            const walletProfile = await this.profiler.getWalletProfile(to);
            const report = this.contextEngine.analyzeWhaleBuy(walletProfile, true, // isFirstEntry
            0.058, // floorChange +5.8%
            -0.09, // listingChange -9%
            11 // uniqueBuyers
            );
            // Push to ClickHouse Analytics
            try {
                await clickhouse_1.clickhouse.insert({
                    table: 'superbot_analytics.whale_trades',
                    values: [{
                            timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
                            chain, contract,
                            whale_address: to,
                            trade_type: 'BUY',
                            usd_value: 0,
                            tx_hash: txHash
                        }],
                    format: 'JSONEachRow'
                });
            }
            catch (err) {
                console.error('[Analytics] Failed to sink whale trade to ClickHouse', err);
            }
            if (trackedBuyer.alertChannelId) {
                await queue_1.discordDeliveryQueue.add('discord_alert', {
                    guildId: trackedBuyer.guildId,
                    channelId: trackedBuyer.alertChannelId,
                    alertType: 'WHALE_BUY',
                    contract, wallet: to, tokenId, txHash,
                    label: trackedBuyer.label,
                    intelligence: report
                }, {
                    jobId: `alert-${trackedBuyer.id}-${eventId}`
                });
            }
        }
    }
    async handleMintRadar(chain, contract) {
        const timeWindowMin = 5;
        const velocityThreshold = 50; // Alert if 50 mints in 5 mins
        const redisKey = `mint_velocity:${chain}:${contract}`;
        // Increment the mint counter
        const currentMints = await queue_1.redisConnection.incr(redisKey);
        // Set expiry on first increment
        if (currentMints === 1) {
            await queue_1.redisConnection.expire(redisKey, timeWindowMin * 60);
        }
        if (currentMints === velocityThreshold) {
            console.log(`🚀 [Mint Radar] High velocity detected on ${chain} for ${contract}!`);
            // Find all guild channels configured for MINT_RADAR
            const mintChannels = await db_1.prisma.alertChannel.findMany({
                where: { alertType: 'MINT_RADAR' },
                include: { guild: true }
            });
            for (const ch of mintChannels) {
                await queue_1.discordDeliveryQueue.add('discord_alert', {
                    guildId: ch.guild.discordId,
                    channelId: ch.discordChannelId,
                    alertType: 'MINT_RADAR',
                    chain, contract,
                    velocity: currentMints,
                    timeWindowMin
                }, {
                    jobId: `mint-alert-${chain}-${contract}-${Date.now()}`
                });
            }
        }
    }
}
exports.EventWorker = EventWorker;
