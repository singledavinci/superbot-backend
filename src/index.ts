import * as dotenv from 'dotenv';
dotenv.config();

/**
 * SuperBot Service Router
 * This script allows a single monorepo to be deployed as multiple microservices
 * on platforms like Railway by setting the SERVICE_TYPE environment variable.
 */

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
}

start();
