import { SuperBot } from './bot';
import { BlockchainIndexer } from './indexer';
import { connectDB } from './db';
import { EventWorker } from './worker';
import { AdminAPI } from './api';
import { initializeClickHouse } from './analytics';

async function main() {
    console.log('🚀 Starting SuperBot Services...');

    // 1. Connect Database
    await connectDB();
    await initializeClickHouse();

    // 2. Start Admin API Dashboard
    const api = new AdminAPI();
    api.start();

    // 3. Start Discord Bot (includes delivery dispatcher)
    const bot = new SuperBot();
    await bot.start();

    // 4. Start Event Worker (processes parsed events)
    const worker = new EventWorker();
    worker.start();

    // 5. Start Blockchain Ingestion (pushes to queue)
    const indexer = new BlockchainIndexer();
    await indexer.start();
}

main().catch(console.error);
