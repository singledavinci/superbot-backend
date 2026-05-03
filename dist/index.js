"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bot_1 = require("./bot");
const indexer_1 = require("./indexer");
const db_1 = require("./db");
const worker_1 = require("./worker");
const api_1 = require("./api");
const analytics_1 = require("./analytics");
async function main() {
    console.log('🚀 Starting SuperBot Services...');
    // 1. Connect Database
    await (0, db_1.connectDB)();
    await (0, analytics_1.initializeClickHouse)();
    // 2. Start Admin API Dashboard
    const api = new api_1.AdminAPI();
    api.start();
    // 3. Start Discord Bot (includes delivery dispatcher)
    const bot = new bot_1.SuperBot();
    await bot.start();
    // 4. Start Event Worker (processes parsed events)
    const worker = new worker_1.EventWorker();
    worker.start();
    // 5. Start Blockchain Ingestion (pushes to queue)
    const indexer = new indexer_1.BlockchainIndexer();
    await indexer.start();
}
main().catch(console.error);
