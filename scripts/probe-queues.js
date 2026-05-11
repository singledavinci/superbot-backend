const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
if (!url) {
    console.error("No REDIS_URL / REDIS_PUBLIC_URL");
    process.exit(1);
}
const conn = new IORedis(url, { maxRetriesPerRequest: null });
/** BullMQ queue names from packages/queue/src/index.ts */
const names = [
    "blockchain_events",
    "discord_delivery",
    "floor_impact",
    "wallet_action_batch",
    "mint_execution",
    "mint_triggers",
    "mint_notifications",
];
(async () => {
    for (const n of names) {
        const q = new Queue(n, { connection: conn });
        const c = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused");
        console.log(n.padEnd(28), JSON.stringify(c));
        await q.close();
    }
    await conn.quit();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
