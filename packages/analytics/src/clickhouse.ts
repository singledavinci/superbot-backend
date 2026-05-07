import { createClient } from '@clickhouse/client';
import * as dotenv from 'dotenv';

dotenv.config();

export const clickhouse = createClient({
    host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: 'default'
});

export async function initializeClickHouse() {
    console.log('📊 Initializing ClickHouse Analytics Schema...');

    try {
        // Create dedicated database
        await clickhouse.command({
            query: `CREATE DATABASE IF NOT EXISTS superbot_analytics`
        });

        // Table: High-Frequency Mint Events
        await clickhouse.command({
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
        await clickhouse.command({
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
    } catch (error) {
        console.error('❌ Failed to initialize ClickHouse:', error);
    }
}
