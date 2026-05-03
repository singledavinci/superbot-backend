import { Worker, Job } from 'bullmq';
import { redisConnection, discordDeliveryQueue } from '../queue';
import { prisma } from '../db';
import { ContextEngine } from '../intelligence';
import { SmartMoneyProfiler } from '../analytics/profiler';
import { clickhouse } from '../analytics/clickhouse';

export class EventWorker {
    private worker: Worker;
    private contextEngine: ContextEngine;
    private profiler: SmartMoneyProfiler;

    constructor() {
        this.contextEngine = new ContextEngine();
        this.profiler = new SmartMoneyProfiler();
        this.worker = new Worker('blockchain_events', this.processJob.bind(this), {
            connection: redisConnection,
            concurrency: 5 // Process 5 events concurrently
        });

        this.worker.on('completed', (job) => {
            // console.log(`[Worker] Job ${job.id} completed`);
        });

        this.worker.on('failed', (job, err) => {
            console.error(`❌ [Worker] Job ${job?.id} failed:`, err);
        });
    }

    public start() {
        console.log('👷 Event Worker started listening for blockchain events...');
    }

    private async processJob(job: Job) {
        if (job.name === 'nft_transfer') {
            await this.handleNftTransfer(job.data);
        }
    }

    private async handleNftTransfer(data: any) {
        const { eventId, chain, contract, from, to, tokenId, txHash, blockNumber } = data;

        // --- MINT RADAR & ANALYTICS SINK ---
        if (from === '0x0000000000000000000000000000000000000000') {
            await this.handleMintRadar(chain, contract);
            
            // Push to ClickHouse Analytics
            try {
                await clickhouse.insert({
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
            } catch (err) {
                console.error('[Analytics] Failed to sink mint event to ClickHouse', err);
            }
        }

        // --- WASH TRADE CHECK ---
        if (this.contextEngine.detectWashTrade(from, to, false)) {
            console.log(`[Worker] Flagged as wash trade, skipping alert: ${txHash}`);
            return;
        }

        // --- WHALE BUY ALERTS ---
        const trackedBuyer = await prisma.trackedWallet.findUnique({
            where: { address: to },
            include: { alertRules: true }
        });

        if (trackedBuyer) {
            const walletProfile = await this.profiler.getWalletProfile(to);
            const report = this.contextEngine.analyzeWhaleBuy(
                walletProfile,
                true, // isFirstEntry
                0.058, // floorChange +5.8%
                -0.09, // listingChange -9%
                11 // uniqueBuyers
            );

            // Push to ClickHouse Analytics
            try {
                await clickhouse.insert({
                    table: 'superbot_analytics.whale_trades',
                    values: [{
                        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
                        chain,
                        contract,
                        whale_address: to,
                        trade_type: 'BUY',
                        usd_value: 0, // Would be fetched from a pricing API
                        tx_hash: txHash
                    }],
                    format: 'JSONEachRow'
                });
            } catch (err) {
                console.error('[Analytics] Failed to sink whale trade to ClickHouse', err);
            }

            for (const rule of trackedBuyer.alertRules) {
                if (rule.isActive && rule.type === 'wallet_buy') {
                    await discordDeliveryQueue.add('discord_alert', {
                        guildId: rule.guildId,
                        channelId: rule.channelId,
                        alertType: 'WHALE_BUY',
                        contract,
                        wallet: to,
                        tokenId,
                        txHash,
                        label: trackedBuyer.label,
                        intelligence: report
                    }, {
                        jobId: `alert-${rule.id}-${eventId}`
                    });
                }
            }
        }
    }

    private async handleMintRadar(chain: string, contract: string) {
        const timeWindowMin = 5;
        const velocityThreshold = 50; // Alert if 50 mints in 5 mins
        
        const redisKey = `mint_velocity:${chain}:${contract}`;
        
        // Increment the mint counter
        const currentMints = await redisConnection.incr(redisKey);
        
        // Set expiry on first increment
        if (currentMints === 1) {
            await redisConnection.expire(redisKey, timeWindowMin * 60);
        }

        if (currentMints === velocityThreshold) {
            console.log(`🚀 [Mint Radar] High velocity detected on ${chain} for ${contract}!`);
            
            // In a real app, query DB for channels subscribed to global mint alerts
            // For MVP, we'll just push a mock alert if a global mint channel exists
            const mintRules = await prisma.alertRule.findMany({
                where: { type: 'global_mint' }
            });

            for (const rule of mintRules) {
                await discordDeliveryQueue.add('discord_alert', {
                    guildId: rule.guildId,
                    channelId: rule.channelId,
                    alertType: 'MINT_RADAR',
                    chain,
                    contract,
                    velocity: currentMints,
                    timeWindowMin
                }, {
                    jobId: `mint-alert-${chain}-${contract}-${Date.now()}` // Debounce built-in
                });
            }
        }
    }
}
