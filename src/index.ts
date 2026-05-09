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
                await import('../apps/bot/src/index');
                break;
            case 'api':
                console.log('🌐 Loading Admin API Service...');
                await import('../apps/api/src/index');
                break;
            case 'indexer':
                console.log('📡 Loading Blockchain Indexer Service...');
                await import('../apps/indexer/src/index');
                break;
            case 'worker':
                console.log('👷 Loading Event Worker Service...');
                await import('../apps/worker/src/index');
                break;
            default:
                console.log('⚡ No SERVICE_TYPE specified. Running in MONOLITH mode (All services in one process)...');
                await Promise.all([
                    import('../apps/api/src/index'),
                    import('../apps/bot/src/index'),
                    import('../apps/indexer/src/index'),
                    import('../apps/worker/src/index')
                ]);
        }
    } catch (error) {
        console.error('❌ Critical Error during service startup:', error);
        process.exit(1);
    }
}

start();
