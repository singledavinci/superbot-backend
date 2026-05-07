import { Worker, Job } from 'bullmq';
import { redisConnection, discordQueue as discordDeliveryQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import { clickhouse, SmartMoneyProfiler } from '@superbot/analytics';
import { SniperEngine } from '@superbot/utils';
import { ContextEngine } from '@superbot/intelligence';
import { ethers, JsonRpcProvider } from 'ethers';


export class EventWorker {
    private snipers = new Map<string, SniperEngine>();
    private profiler = new SmartMoneyProfiler();
    private contextEngine = new ContextEngine();
    private providers = new Map<string, JsonRpcProvider>();
    private profileCache = new Map<string, { profile: any, timestamp: number }>();
    private CACHE_TTL = 10 * 60 * 1000; // 10 minutes

    constructor() {
        // Initialize providers for sniping/data fetching
        this.providers.set('ethereum', new JsonRpcProvider(process.env.WSS_RPC_URL));
        this.providers.set('polygon', new JsonRpcProvider(process.env.POLYGON_WSS_RPC_URL));
        this.providers.set('base', new JsonRpcProvider(process.env.BASE_WSS_RPC_URL));

        // Initialize sniper engines per chain
        for (const [chain, provider] of this.providers) {
            this.snipers.set(chain, new SniperEngine(provider));
        }
    }

    public async start() {
        console.log('👷 Event Worker started. Processing high-velocity NFT events...');

        const worker = new Worker('nft_events', async (job: Job) => {
            const { type, chain, contract, from, to, tokenId, txHash, eventId } = job.data;

            if (type === 'transfer') {
                await this.handleTransfer(chain, contract, from, to, tokenId, txHash, eventId);
            } else if (type === 'mint_radar') {
                await this.handleMintRadar(chain, contract);
            }
        }, { 
            connection: redisConnection,
            concurrency: 5
        });

        worker.on('failed', (job, err) => {
            console.error(`❌ Job ${job?.id} failed:`, err);
        });
    }

    private async handleTransfer(chain: string, contract: string, from: string, to: string, tokenId: string, txHash: string, eventId: string) {
        // 1. Personal Watchlist Tracking (Sniping)
        const usersTrackingThisWhale = await prisma.user.findMany({
            where: {
                watchlists: {
                    some: {
                        targetType: 'wallet',
                        targetAddress: { equals: to, mode: 'insensitive' }
                    }
                }
            }
        });

        // 2. Server-wide Tracking (Alerts)
        const trackedBuyers = await prisma.trackedWallet.findMany({
            where: { address: { equals: to, mode: 'insensitive' } }
        });

        if (usersTrackingThisWhale.length === 0 && trackedBuyers.length === 0) return;

        // If it's a mint, fetch full transaction data for sniping
        let txData: any = null;
        if (from === '0x0000000000000000000000000000000000000000') {
            try {
                const provider = this.providers.get(chain);
                if (provider) {
                    txData = await provider.getTransaction(txHash);
                }
            } catch (err) {
                console.error(`[Worker] Failed to fetch tx data for ${txHash}:`, err);
            }
        }

        // Handle Personal Sniping
        for (const user of usersTrackingThisWhale) {
            if (user.autoMintEnabled && user.encryptedPrivateKey && txData && from === '0x0000000000000000000000000000000000000000') {
                const sniper = this.snipers.get(chain);
                if (sniper) {
                    try {
                        const pk = Buffer.from(user.encryptedPrivateKey, 'hex').toString();
                        const finalData = await sniper.preparePayload(txData.data, to, '0x...'); // Logic handles internal resolution
                        
                        console.log(`🎯 [Sniper] Triggering copy-trade for user ${user.discordId} on ${contract}`);
                        await sniper.executeCopyTrade(pk, txData.to!, finalData, txData.value.toString(), {
                            maxMintLimit: user.maxMintPrice,
                            gasBribeGwei: user.gasBufferGwei,
                            skipSimulation: true
                        });
                    } catch (err) {
                        console.error(`[Sniper] Copy-trade failed for user ${user.discordId}:`, err);
                    }
                }
            }
        }

        // Handle Server Alerts
        if (trackedBuyers.length > 0) {
            // Use cached profile if available to reduce overhead
            const cached = this.profileCache.get(to);
            let walletProfile;

            if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
                walletProfile = cached.profile;
            } else {
                walletProfile = await this.profiler.getWalletProfile(to);
                this.profileCache.set(to, { profile: walletProfile, timestamp: Date.now() });
            }

            const report = this.contextEngine.analyzeWhaleBuy(
                walletProfile,
                true,   // isFirstEntry (mock)
                0.058,  // floorChange +5.8% (mock)
                -0.09,  // listingChange -9% (mock)
                11      // uniqueBuyers (mock)
            );

            // Push to ClickHouse Analytics
            try {
                await clickhouse.insert({
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
            } catch (err) {
                console.error('[Analytics] Failed to sink whale trade to ClickHouse', err);
            }

            for (const trackedBuyer of trackedBuyers) {
                if (trackedBuyer.alertChannelId) {
                    await discordDeliveryQueue.add('discord_alert', {
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
    }

    private async handleMintRadar(chain: string, contract: string) {
        const velocityThreshold = 50; 
        const redisKey = `mint_velocity:${chain}:${contract}`;
        const currentMints = await redisConnection.incr(redisKey);
        
        if (currentMints === 1) {
            await redisConnection.expire(redisKey, 300); // 5 mins
        }

        if (currentMints === velocityThreshold) {
            const mintChannels = await prisma.alertChannel.findMany({
                where: { alertType: 'MINT_RADAR' },
                include: { guild: true }
            });

            for (const ch of mintChannels) {
                await discordDeliveryQueue.add('discord_alert', {
                    guildId: ch.guild.discordId,
                    channelId: ch.discordChannelId,
                    alertType: 'MINT_RADAR',
                    chain, contract,
                    velocity: currentMints,
                    timeWindowMin: 5
                }, {
                    jobId: `mint-alert-${chain}-${contract}-${Date.now()}`
                });
            }
        }
    }
}
