"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.clickhouse = void 0;
exports.initializeClickHouse = initializeClickHouse;
const client_1 = require("@clickhouse/client");
const dotenv = __importStar(require("dotenv"));
dotenv.config();
exports.clickhouse = (0, client_1.createClient)({
    host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: 'default'
});
async function initializeClickHouse() {
    console.log('📊 Initializing ClickHouse Analytics Schema...');
    try {
        // Create dedicated database
        await exports.clickhouse.command({
            query: `CREATE DATABASE IF NOT EXISTS superbot_analytics`
        });
        // Table: High-Frequency Mint Events
        await exports.clickhouse.command({
            query: `
                CREATE TABLE IF NOT EXISTS superbot_analytics.mints (
                    timestamp DateTime,
                    chain String,
                    contract String,
                    to_address String,
                    token_id String,
                    tx_hash String
                ) ENGINE = MergeTree()
                ORDER BY (chain, contract, timestamp)
            `
        });
        // Table: Whale Trading Activity
        await exports.clickhouse.command({
            query: `
                CREATE TABLE IF NOT EXISTS superbot_analytics.whale_trades (
                    timestamp DateTime,
                    chain String,
                    contract String,
                    whale_address String,
                    trade_type String, -- 'BUY', 'SELL', 'MINT'
                    usd_value Float32,
                    tx_hash String
                ) ENGINE = MergeTree()
                ORDER BY (chain, whale_address, timestamp)
            `
        });
        console.log('✅ ClickHouse Schema Ready!');
    }
    catch (error) {
        console.error('❌ Failed to initialize ClickHouse:', error);
    }
}
//# sourceMappingURL=clickhouse.js.map