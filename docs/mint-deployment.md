# Mint engine and mint-executor-bot — deployment

Monorepo entry: `src/index.ts`. Process role is selected with **`SERVICE_TYPE`** (`mint-engine`, `mint-executor-bot`, etc.). See root `package.json` scripts.

## Railway services

If **`superbot-mint-engine`** has **no GitHub repo attached** in Railway (service **Settings → Source**), deployments will **not** pick up commits from this repository — health checks can stay on an **old stub** forever. Connect the **`singledavinci/superbot-backend`** repo (or your canonical fork), branch **`master`**, root directory **`.`**, build **`npm run build`**, start **`npm run start:mint-engine`** (or **`npm run start`** with **`SERVICE_TYPE=mint-engine`** in variables).

Recommended separate services (do **not** merge into the main intelligence bot):

| Service | `SERVICE_TYPE` | Purpose |
|---------|----------------|---------|
| `superbot-mint-engine` | `mint-engine` | HTTP HMAC API: preflight, prepare, simulation; **no** signing/broadcast in prepare mode. |
| `superbot-mint-executor-bot` | `mint-executor-bot` | Discord slash: `/mint-status`, `/mint-preflight`, `/mint-approve`, `/mint-revoke`, `/mint-approvals`, etc. |

Existing intelligence stack (`bot`, `api`, `worker`, indexers, `floor-worker`) stays unchanged.

### Public URL (mint-engine)

Generate a Railway domain (port = process `PORT`, typically **8080**):

```bash
npx @railway/cli domain --service superbot-mint-engine -p 8080 --json
```

Point **`MINT_ENGINE_URL`** on the executor bot at that HTTPS origin (or use private networking — see Railway private DNS docs).

### Environment — mint-engine (prepare-only, safe defaults)

| Variable | Required | Notes |
|----------|----------|--------|
| `SERVICE_TYPE` | yes | `mint-engine` |
| `DATABASE_URL` | yes | Same Postgres as core SuperBot; Railway: `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | yes | `${{Redis.REDIS_URL}}` |
| `MINT_ENGINE_SERVICE_SECRET` | yes | Shared HMAC secret with executor + smoke script; **rotate** if leaked. |
| `HTTPS_RPC_URLS` or `MINT_ENGINE_RPC_URL` | yes | JSON-RPC for chain reads/simulation. |
| `OPENSEA_API_KEY` | yes for SeaDrop resolver | Official OpenSea API key. |
| `MINT_EXECUTION_ENABLED` | yes | **`false`** until live execution is explicitly approved. |
| `MINT_MAINNET_BROADCAST_ENABLED` | yes | **`false`** |
| `MINT_ENGINE_MODE` | yes | **`prepare`** for prepare-only beta proof. |
| `MINT_TESTNET_ONLY` | recommended | `true` unless you intentionally use mainnet read-only RPC. |
| `MINT_REQUIRE_SECURE_SIGNER` | recommended | `true` |
| `MINT_COPY_PENDING_ENABLED` | recommended | `false` |
| `MINT_ALLOW_PRIVATE_RELAY` | recommended | `false` |
| `MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS` | recommended | `false` (legacy name; **SuperBot does not register `mint-*` slash commands** — use the mint-executor Discord app only). |

`PORT` is set by Railway; the engine binds **`PORT` first**, then `MINT_ENGINE_PORT`, default `3847` locally.

### Environment — mint-executor-bot

| Variable | Required | Notes |
|----------|----------|--------|
| `SERVICE_TYPE` | yes | `mint-executor-bot` |
| `MINT_EXECUTOR_DISCORD_TOKEN` | yes | **Dedicated** bot application token (do not reuse main `DISCORD_TOKEN`). |
| `MINT_EXECUTOR_DISCORD_APPLICATION_ID` | recommended | Discord **Application** snowflake for Supermint (Developer Portal → OAuth2). If set and the login token resolves to a different app id, slash registration is **skipped** so commands never attach to the wrong bot. |
| `MINT_EXECUTOR_REGISTER_SLASH_COMMANDS` | optional | Default `true`. Set `false` to run the executor without touching Discord command registration. |
| `MINT_ENGINE_URL` | yes | Public HTTPS mint-engine URL or internal service URL. |
| `MINT_ENGINE_SERVICE_SECRET` | yes | **Same** value as mint-engine. |
| `MINT_EXECUTOR_GUILD_ID` | optional | Your Discord **server** snowflake. When set, slash commands are registered on that guild for **immediate** visibility while testing; **global** commands alone can take **up to ~1 hour** to appear everywhere. |
| `MINT_EXECUTOR_REGISTER_GLOBAL_COMMANDS` | optional | When **`MINT_EXECUTOR_GUILD_ID`** is set, defaults to **not** registering **global** commands (avoids duplicate `/mint-*` in the picker from guild + global). Set to **`true`** only if you intentionally want both. |
| `MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS` | optional | Reserved / mint-engine config; **SuperBot never registers `mint-*` slash commands** — mint UX is only on the mint-executor Discord application. |

### Start command (mint-engine service)

Use **`npm run start:mint-engine`** so **`SERVICE_TYPE=mint-engine`** is always set from the script (Linux/macOS). Alternatively **`npm run start`** with **`SERVICE_TYPE=mint-engine`** defined in Railway variables.

If **`SERVICE_TYPE`** is missing, the root router falls through to **MONOLITH** mode and **does not** run the mint-engine HTTP server — health checks may hit the wrong process or an outdated deployment.

### Build / lockfile

Railway runs **`npm ci`**. After adding workspace packages (`apps/mint-engine`, `apps/mint-executor-bot`), run **`npm install`** locally and commit the updated **`package-lock.json`**.

`npm run build` removes **`dist/`** first (`scripts/clean-dist.cjs`) then runs **`tsc`**, so renamed/removed sources do not leave stale compiled files (e.g. orphan `mint-approve-wallet.js` next to `mint-approve.js`). It then runs **`scripts/verify-mint-engine-dist.cjs`** so CI/Railway builds fail if the compiled mint-engine health module is missing from **`dist/`**.

## Database

### Identity

```bash
npm run db:identity
```

Confirm `current_database`, `current_user`, and table list. Use the **same** `DATABASE_URL` as mint-engine.

### P3005 (non-empty DB, no Prisma history)

If `prisma migrate deploy` fails with **P3005**, the database already had tables before `_prisma_migrations` existed. Safe approaches:

1. **`prisma migrate resolve --applied "<migration_name>"`** only for migrations whose SQL **already matches** production (no destructive DDL you have not applied).
2. **`migrate resolve --rolled-back`** on a failed migration, **fix the SQL** (e.g. idempotent / compatible with a newer index), then **`migrate deploy`** again.

This repo’s `20260510_add_core_tables` migration skips recreating `AlertChannel_discordChannelId_key` when `AlertChannel_guildId_alertType_key` already exists (production dedupe path).

**Never** `prisma migrate reset` on production.

### Migrate and verify mint DDL

```bash
npm run db:migrate
npm run db:verify-mint
```

`db:verify-mint` checks all mint tables and **`NonceLock_active_nonce_unique`**.

## Seed (smoke identities)

Set `SMOKE_GUILD_DISCORD_ID`, `SMOKE_USER_DISCORD_ID`, `SMOKE_WALLET_ADDRESS` (lowercase `0x`), `SMOKE_CHAIN_ID`, and `DATABASE_URL`, then:

```bash
npm run seed:mint-smoke
```

No private keys; `MintWallet.isExecutionEnabled` stays `false`; `signerType` is prepare/simulation-safe.

## Operator smoke (after deploy)

```bash
npm run smoke:mint-preflight -- \
  --contract <REAL_SEADROP_0x> \
  --wallet <SMOKE_WALLET> \
  --quantity 1 \
  --mode prepare \
  --chain-id 1
```

Do **not** use `--skip-job` for the final “prepare-only beta” proof. See `docs/smoke-mint-preflight.md` and `docs/mint-smoke-production.md`.

## Health endpoints (mint-engine)

- `GET /health/mint-engine`
- `GET /health/mint-providers`
- `GET /health/mint-clock` (may report `HIGH_DRIFT` if RPC clock skew is large — tune RPC or skew tolerance)
- `GET /metrics`

## Troubleshooting

| Symptom | Check |
|---------|--------|
| SSL errors to Postgres from laptop | Use Railway **public** TCP proxy URL or run migrate from Railway/network that trusts the endpoint. |
| HMAC 401/403 / `BAD_SIGNATURE` | Same `MINT_ENGINE_SERVICE_SECRET` on engine, executor, and local `.env` (trim whitespace/BOM). Redeploy mint-engine after auth fixes. Path signed must be full `/v1/mint/...` (engine uses `baseUrl + path`). |
| Redis connection | `REDIS_URL` must be reachable from the service (internal vs public proxy). |
| `npm ci` fails on Railway | `package-lock.json` out of sync with workspaces — run `npm install`, commit lockfile. |
| Executor bot exits immediately | **`MINT_EXECUTOR_DISCORD_TOKEN`** missing or invalid. |
| **`GET /health/mint-engine`** returns only ~5 fields (`mode`, `executionEnabled`, `emergencyStop`, …) | Deploy is **stale** or **wrong start command** — ensure **`npm run build`** succeeds (verify script passes), redeploy from **`master`**, use **`npm run start:mint-engine`** or set **`SERVICE_TYPE=mint-engine`**. A current deployment returns **`healthSchemaVersion`** **2** plus **`mainnetBroadcastEnabled`**, **`signerConfigured`**, etc., and response header **`X-Mint-Engine-Health-Schema: 2`**. |

## Verdict

Do **not** claim **“Prepare-only beta ready”** until real SeaDrop smoke + Discord `/mint-preflight` and `/mint-result` pass with persisted `MintJob` / `MintSimulation`, `signingOccurred=false`, `broadcastOccurred=false`, and no `eth_sendRawTransaction`.

## Secret rotation

If variables were ever dumped to disk or chat, rotate Postgres, Redis, Discord tokens, RPC URLs with embedded keys, `JWT_SECRET`, ClickHouse creds, and **`MINT_ENGINE_SERVICE_SECRET`**, then update Railway and local `.env` (never commit `.env`).
