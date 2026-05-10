import * as dotenv from 'dotenv';
dotenv.config();

/**
 * SuperBot Service Router
 * This script allows a single monorepo to be deployed as multiple microservices
 * on platforms like Railway by setting the SERVICE_TYPE environment variable.
 */

// Process-level safety net: a stray async error in any service (e.g. a transient
// 429 from a chain RPC bubbling up as an unhandled WebSocket 'error' event) must
// NOT take down the whole process. Especially in MONOLITH mode where API/bot/indexer/worker
// share one process, this prevents one chain blip from crashing all services.
process.on('uncaughtException', (err) => {
    console.error('[Process] uncaughtException:', err instanceof Error ? err.stack || err.message : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Process] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
});

async function start() {
    const service = process.env.SERVICE_TYPE;

    console.log(`🚀 Starting SuperBot Service Architecture...`);
    console.log(`[System] SERVICE_TYPE: ${service || 'MONOLITH'}`);

    try {
        switch (service) {
            case 'bot':
                console.log('🤖 Loading Discord Bot Service...');
                // Use relative paths to ensure resolution within the shared 'dist' directory
                const { SuperBot } = await import('../apps/bot/src/index');
                const bot = new SuperBot();
                await bot.start();
                break;
            case 'api':
                console.log('🌐 Loading Admin API Service...');
                const { AdminAPI } = await import('../apps/api/src/index');
                const api = new AdminAPI();
                api.start();
                break;
            case 'indexer':
                console.log('📡 Loading Blockchain Indexer Service...');
                const { BlockchainIndexer } = await import('../apps/indexer/src/index');
                const indexer = new BlockchainIndexer();
                await indexer.start();
                break;
            case 'worker':
                console.log('👷 Loading Event Worker Service...');
                const { EventWorker } = await import('../apps/worker/src/index');
                const worker = new EventWorker();
                await worker.start();
                break;
            case 'sales-indexer':
                console.log('💱 Loading Sales Indexer Service...');
                const { SalesIndexer } = await import('../apps/sales-indexer/src/index');
                const salesIndexer = new SalesIndexer();
                await salesIndexer.start();
                break;
            case 'market-indexer':
                console.log('📊 Loading Market Indexer Service...');
                const { MarketIndexer } = await import('../apps/market-indexer/src/index');
                const marketIndexer = new MarketIndexer();
                await marketIndexer.start();
                break;
            default:
                console.log('⚡ No SERVICE_TYPE specified. Running in MONOLITH mode (All services in one process)...');
                const [BotMod, ApiMod, IndexerMod, WorkerMod] = await Promise.all([
                    import('../apps/bot/src/index'),
                    import('../apps/api/src/index'),
                    import('../apps/indexer/src/index'),
                    import('../apps/worker/src/index')
                ]);
                
                const monolithApi = new ApiMod.AdminAPI();
                monolithApi.start();
                
                const monolithBot = new BotMod.SuperBot();
                await monolithBot.start();
                
                const monolithIndexer = new IndexerMod.BlockchainIndexer();
                await monolithIndexer.start();
                
                const monolithWorker = new WorkerMod.EventWorker();
                await monolithWorker.start();
        }
    } catch (error) {
        console.error('❌ Critical Error during service startup:', error);
        process.exit(1);
    }

    // Keep the process alive for services that use listeners (like the API)
    // or if the event loop would otherwise be empty.
    console.log('🏁 Service startup sequence complete. Process is now active.');
    await new Promise(() => {}); 
}

start().catch(err => {
    console.error('🔥 Fatal Uncaught Error during initialization:', err);
    process.exit(1);
});
