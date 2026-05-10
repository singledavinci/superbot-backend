import { Worker, Job } from 'bullmq';
import { redisConnection, discordQueue as discordDeliveryQueue } from '@superbot/queue';
import { prisma } from '@superbot/database';
import {
    clickhouse,
    SmartMoneyProfiler,
    SweepDetector,
    type NormalizedSale,
    type SweepDetection,
} from '@superbot/analytics';
import { SniperEngine } from '@superbot/utils';
import { ContextEngine, SaleDetector } from '@superbot/intelligence';
import { ethers, JsonRpcProvider } from 'ethers';

/**
 * SaleDetector and other JsonRpcProvider clients require an HTTP(S) endpoint;
 * passing them a `wss://` URL produces silent failures. We accept either an
 * explicit HTTPS env var or fall back to converting the WSS URL to HTTPS,
 * since Alchemy serves both at the same host.
 */
function resolveHttpRpcUrl(wssEnv: string, httpEnv: string): string | null {
    const explicit = process.env[httpEnv]?.trim();
    if (explicit) return explicit;

    const wss = process.env[wssEnv]?.trim();
    if (!wss) return null;
    if (wss.startsWith('http://') || wss.startsWith('https://')) return wss;
    if (wss.startsWith('wss://')) return 'https://' + wss.slice('wss://'.length);
    if (wss.startsWith('ws://')) return 'http://' + wss.slice('ws://'.length);
    return null;
}


export class EventWorker {
    private snipers = new Map<string, SniperEngine>();
    private profiler = new SmartMoneyProfiler();
    private contextEngine = new ContextEngine();
    private sweepDetector = new SweepDetector();
    private saleDetectors = new Map<string, SaleDetector>();
    private providers = new Map<string, JsonRpcProvider>();
    private profileCache = new Map<string, { profile: any, timestamp: number }>();
    private CACHE_TTL = 10 * 60 * 1000; // 10 minutes
    private SNIPING_ENABLED = false; // Hard-disabled for security per audit

    constructor() {
        // Ethereum-only deployment. Re-add other chains here together with their
        // *_WSS_RPC_URL env vars when expanding multi-chain support.
        const ethHttpUrl = resolveHttpRpcUrl('WSS_RPC_URL', 'HTTPS_RPC_URL');
        if (ethHttpUrl) {
            this.providers.set('ethereum', new JsonRpcProvider(ethHttpUrl));
            this.saleDetectors.set('ethereum', new SaleDetector(ethHttpUrl));
        } else {
            console.warn('[Worker] No Ethereum RPC URL configured; sale detection will be disabled.');
        }
    }

    public async start() {
        console.log('👷 Event Worker started. Processing high-velocity NFT events...');

        // Match the queue published by the indexer (`packages/queue` exports `eventQueue` -> 'blockchain_events').
        const worker = new Worker('blockchain_events', async (job: Job) => {
            const { type, chain, contract, from, to, tokenId, txHash, eventId } = job.data;

            // Indexer emits 'erc721_transfer' or 'erc1155_transfer'; treat both as transfers.
            if (type === 'erc721_transfer' || type === 'erc1155_transfer' || type === 'transfer') {
                await this.handleTransfer(chain, contract, from, to, tokenId, txHash, eventId, job.data);

                // Detect mint surges for trending mint radar
                if (from === '0x0000000000000000000000000000000000000000') {
                    await this.handleMintRadar(chain, contract);
                }
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

    private async handleTransfer(
        chain: string,
        contract: string,
        from: string,
        to: string,
        tokenId: string,
        txHash: string,
        eventId: string,
        rawJob: Record<string, unknown>,
    ) {
        const jobPriceNative =
            typeof rawJob.priceNative === 'number'
                ? rawJob.priceNative
                : rawJob.priceNative != null
                  ? Number(rawJob.priceNative)
                  : undefined;
        const jobCurrency = typeof rawJob.currency === 'string' ? rawJob.currency : undefined;
        const jobMarketplace = typeof rawJob.marketplace === 'string' ? rawJob.marketplace : undefined;
        const jobTs =
            typeof rawJob.timestamp === 'number'
                ? rawJob.timestamp
                : rawJob.timestamp != null
                  ? Number(rawJob.timestamp)
                  : undefined;
        const jobBlock =
            typeof rawJob.blockNumber === 'number'
                ? rawJob.blockNumber
                : rawJob.blockNumber != null
                  ? Number(rawJob.blockNumber)
                  : undefined;

        const trackedCollections = await prisma.trackedCollection.findMany({
            where: {
                chain: 'ethereum',
                contractAddress: { equals: contract, mode: 'insensitive' },
            },
        });

        const trackedBuyers = await prisma.trackedWallet.findMany({
            where: { address: { equals: to, mode: 'insensitive' } },
        });

        const trackedSellers = await prisma.trackedWallet.findMany({
            where: { address: { equals: from, mode: 'insensitive' } },
        });

        if (
            trackedCollections.length === 0 &&
            trackedBuyers.length === 0 &&
            trackedSellers.length === 0
        ) {
            return;
        }

        // Detect Event Type: MINT, SALE, or TRANSFER
        let eventType = 'TRANSFER';
        let price = '0';
        let currency = jobCurrency || 'ETH';
        let marketplace = jobMarketplace || '';

        if (from === '0x0000000000000000000000000000000000000000') {
            eventType = 'MINT';
        } else {
            const detector = this.saleDetectors.get(chain);
            if (detector) {
                const saleInfo = await detector.detectSale(txHash);
                if (saleInfo.isSale) {
                    eventType = 'SALE';
                    price = saleInfo.price || '0';
                    currency = saleInfo.currency || 'ETH';
                    marketplace = saleInfo.marketplace || 'Unknown';
                }
            }
        }

        const effectivePriceEth =
            parseFloat(price) > 0 ? parseFloat(price) : jobPriceNative && jobPriceNative > 0 ? jobPriceNative : 0;

        if (effectivePriceEth > 0 && from !== '0x0000000000000000000000000000000000000000') {
            const normalized: NormalizedSale = {
                eventId: eventId || `${txHash}:${tokenId}`,
                chain: chain || 'ethereum',
                contract: contract.toLowerCase(),
                tokenId,
                txHash,
                blockNumber: jobBlock,
                timestamp: jobTs && jobTs > 0 ? jobTs : Math.floor(Date.now() / 1000),
                buyer: to.toLowerCase(),
                seller: from.toLowerCase(),
                priceNative: effectivePriceEth,
                currency,
                marketplace: marketplace || jobMarketplace || 'unknown',
                raw: rawJob,
            };

            const sweep = this.sweepDetector.ingest(normalized);
            if (sweep && trackedCollections.length > 0) {
                await this.dispatchSweep(sweep, trackedCollections);
            }
        }

        if (trackedBuyers.length === 0 && trackedSellers.length === 0) return;

        if (from !== '0x0000000000000000000000000000000000000000' && eventType !== 'SALE' && effectivePriceEth > 0) {
            eventType = 'SALE';
            price = String(effectivePriceEth);
        }

        // 3. Analytics Persistence (ClickHouse)
        try {
            await clickhouse.insert({
                table: 'superbot_analytics.whale_trades',
                values: [{
                    timestamp: new Date(),
                    chain,
                    contract,
                    whale_address: eventType === 'SALE' ? (price === '0' ? from : to) : to, 
                    trade_type: eventType,
                    usd_value: 0, 
                    tx_hash: txHash
                }],
                format: 'JSONEachRow'
            });
        } catch (err) {
            console.error('[Worker] ClickHouse insert failed:', err);
        }

        // 4. Alert Delivery
        const combinedTracked = [...trackedBuyers, ...trackedSellers];
        const uniqueGuilds = new Set(combinedTracked.map(t => t.guildId));

        for (const guildId of uniqueGuilds) {
            const guild = await prisma.guild.findUnique({
                where: { id: guildId },
                include: { alertChannels: true }
            });

            if (!guild) continue;

            const relevantWallets = combinedTracked.filter(t => t.guildId === guildId);

            for (const wallet of relevantWallets) {
                for (const channel of guild.alertChannels) {
                    if (channel.alertType === 'WHALE_BUY' || channel.alertType === 'COLLECTION_TRACK') {
                        // Fetch profile (neutral per audit rules)
                        const profile = await this.profiler.getWalletProfile(to);
                        const intelligence = this.contextEngine.analyzeWhaleBuy(profile, true, null, null, null);

                        await discordDeliveryQueue.add('discord_alert', {
                            eventId,
                            channelId: channel.discordChannelId,
                            alertType: eventType === 'SALE' ? 'WHALE_SALE' : (eventType === 'MINT' ? 'WHALE_MINT' : 'WHALE_BUY'),
                            contract,
                            wallet: to,
                            label: wallet.label,
                            tokenId,
                            txHash,
                            price,
                            currency,
                            marketplace,
                            intelligence,
                            mentionRoleId: wallet.mentionRoleId // Pass the role ID from the database
                        }, {
                            jobId: `alert-${wallet.id}-${eventId}`
                        });
                    }
                }
            }
        }
    }

    private async dispatchSweep(
        sweep: SweepDetection,
        collections: {
            id: string;
            alertChannelId: string | null;
            mentionRoleId: string | null;
            name: string;
            sweepThresholdNative: number | null;
        }[],
    ) {
        const envMinTotal = Number(process.env.SWEEP_MIN_TOTAL_NATIVE) || 0.5;

        for (const row of collections) {
            const minTotal = row.sweepThresholdNative ?? envMinTotal;
            if (sweep.totalNative < minTotal) continue;
            if (!row.alertChannelId) continue;

            await discordDeliveryQueue.add(
                'discord_alert',
                {
                    eventId: sweep.eventId,
                    channelId: row.alertChannelId,
                    alertType: 'SWEEP',
                    contract: sweep.contract,
                    chain: sweep.chain,
                    collectionName: row.name,
                    buyer: sweep.buyer,
                    txHash: sweep.txHash,
                    itemCount: sweep.itemCount,
                    totalNative: sweep.totalNative,
                    currency: sweep.currency,
                    tokenIds: sweep.tokenIds,
                    mentionRoleId: row.mentionRoleId,
                },
                {
                    jobId: `sweep-${row.id}-${sweep.eventId}`,
                    removeOnComplete: { age: 3600 },
                    removeOnFail: { age: 86400 },
                },
            );
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

            // Use a deterministic time-bucketed eventId so dedupe works across worker replicas
            const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
            const eventId = `mint-radar-${chain}-${contract}-${bucket}`;
            for (const ch of mintChannels) {
                await discordDeliveryQueue.add('discord_alert', {
                    eventId,
                    guildId: ch.guild.discordId,
                    channelId: ch.discordChannelId,
                    alertType: 'MINT_RADAR',
                    chain, contract,
                    velocity: currentMints,
                    timeWindowMin: 5
                }, {
                    jobId: `mint-alert-${chain}-${contract}-${bucket}`
                });
            }
        }
    }
}

if (require.main === module) {
    const worker = new EventWorker();
    worker.start().catch(err => {
        console.error('❌ Failed to start Event Worker:', err);
        process.exit(1);
    });
}
