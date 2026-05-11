const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
if (!url) {
    console.error("No REDIS_URL / REDIS_PUBLIC_URL");
    process.exit(1);
}
const conn = new IORedis(url, { maxRetriesPerRequest: null });
const QUEUES = ["blockchain_events", "wallet_action_batch"];

(async () => {
    for (const name of QUEUES) {
        const q = new Queue(name, { connection: conn });
        const before = await q.getJobCounts("failed");
        const failedBefore = before.failed ?? 0;
        console.log(`${name}: failed before = ${failedBefore}`);
        const removed = await q.clean(0, 1000, "failed");
        const after = await q.getJobCounts("failed");
        const failedAfter = after.failed ?? 0;
        console.log(`${name}: cleaned ${removed.length} job(s), failed after = ${failedAfter}`);
        await q.close();
    }
    await conn.quit();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
