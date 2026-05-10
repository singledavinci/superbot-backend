## Railway setup — adding `superbot-sales-indexer`

This service runs the Reservoir-backed sales indexer (`apps/sales-indexer`) as a separate
Railway service so it can be scaled independently of the API/bot/indexer/worker.

### One-time prerequisites
- Authenticated Railway CLI (`railway whoami`) or `RAILWAY_API_TOKEN` env var.
- Repo already linked to project: `railway project link -p <PROJECT_ID> -e production`.

### Required environment variables on the new service
- `SERVICE_TYPE=sales-indexer` (drives the service router in `src/index.ts`).
- `DATABASE_URL` — share with Postgres service via reference: `${{Postgres.DATABASE_URL}}`.
- `REDIS_URL` — share with Redis service via reference: `${{Redis.REDIS_URL}}`.
- `RESERVOIR_API_KEY` — your Reservoir API key (https://reservoir.tools).
  - Without a real key the indexer logs `RESERVOIR_API_KEY not configured; sales indexer is disabled.` and emits no events.
- `RESERVOIR_POLL_INTERVAL_MS` (optional) — default 30_000.

### CLI flow (executable)
The repo includes `scripts/setup-sales-indexer.ps1` which does all the steps below. To run
manually instead, the CLI commands are:

```powershell
# 1) Create the service from the same backend repo
railway add `
    --service superbot-sales-indexer `
    --repo singledavinci/superbot-backend `
    --variables "SERVICE_TYPE=sales-indexer" `
    --variables "DATABASE_URL=`${{Postgres.DATABASE_URL}}" `
    --variables "REDIS_URL=`${{Redis.REDIS_URL}}" `
    --variables "RESERVOIR_POLL_INTERVAL_MS=30000" `
    --variables "RESERVOIR_API_KEY=PLACEHOLDER_set_a_real_key" `
    --json

# 2) Once you have a real Reservoir key, replace the placeholder:
railway variable set RESERVOIR_API_KEY=<YOUR_RESERVOIR_KEY> `
    --service superbot-sales-indexer --environment production --skip-deploys

# 3) Trigger a redeploy after setting the real key
railway redeploy --service superbot-sales-indexer --yes
```

### How the service runs
- Build: nixpacks detects `package.json` and runs `npm run build`
  (which runs `prisma generate` + `tsc`).
- Start: `node dist/src/index.js` reads `SERVICE_TYPE=sales-indexer` and
  routes to `apps/sales-indexer/src/index.ts` → `SalesIndexer.start()`.
- Idempotency: Reservoir's stable sale id is reused as the BullMQ `jobId`,
  so duplicate sales are dropped at the queue layer.
- Delivery dedupe is then enforced again per-channel in the bot via
  `AlertDeliveryLog.deliveryKey = ${alertType}:${eventId}:${channelId}`.

### Verifying after deploy
```powershell
# Watch logs for the new service
railway logs --service superbot-sales-indexer --environment production

# When unconfigured you should see:
#   [SalesIndexer] RESERVOIR_API_KEY not configured; sales indexer is disabled.
# Once configured and a tracked collection has new sales, you should see jobs
# pushed to `blockchain_events` and an `AlertDeliveryLog` row per delivered alert.
```
