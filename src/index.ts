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
                await import('@superbot/bot');
                break;
            case 'api':
                console.log('🌐 Loading Admin API Service...');
                await import('@superbot/api');
                break;
            case 'indexer':
                console.log('📡 Loading Blockchain Indexer Service...');
                await import('@superbot/indexer');
                break;
            case 'worker':
                console.log('👷 Loading Event Worker Service...');
                await import('@superbot/worker');
                break;
            default:
                console.log('⚡ No SERVICE_TYPE specified. Running in MONOLITH mode (All services in one process)...');
                await Promise.all([
                    import('@superbot/api'),
                    import('@superbot/bot'),
                    import('@superbot/indexer'),
                    import('@superbot/worker')
                ]);
        }
    } catch (error) {
        console.error('❌ Critical Error during service startup:', error);
        process.exit(1);
    }
}

start();
