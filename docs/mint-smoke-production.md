# Mint smoke on production / Railway Postgres

See also **[mint-deployment.md](./mint-deployment.md)** (Railway services, env, P3005, health, troubleshooting).

End-to-end prepare-only proof: migrate → seed → mint-engine → `npm run smoke:mint-preflight` → Discord. **No live signing, no broadcast.**

## Step 1 — Secret hygiene (operator)

If variables were ever written to disk (e.g. `railway variable list --json`):

1. **Delete** those JSON files from `%TEMP%`, Downloads, and the repo workspace.
2. **Rotate** anything that could have been exposed, including:
   - Discord bot token(s) and mint-executor bot token
   - `DATABASE_URL` / Postgres user password
   - `REDIS_URL` / Redis password
   - `OPENSEA_API_KEY`
   - Any Alchemy / QuickNode / Infura URLs containing keys
   - `JWT_SECRET`, ClickHouse credentials
   - Railway tokens / `MINT_ENGINE_SERVICE_SECRET` if it appeared in a dump
3. Update **Railway service variables** (or your secret manager) with new values — **never** commit them.

Do not log full connection strings or API keys.

## Step 2 — Confirm `DATABASE_URL`

The URL must be the **same** Postgres instance `SERVICE_TYPE=mint-engine` uses (typically `${{Postgres.DATABASE_URL}}` on Railway, or the public proxy URL only if the service is off-platform).

```bash
npm run db:identity
```

Check `current_database`, `current_user`, host summary, and that expected core tables exist. If multiple Postgres services exist in the project, pick the one attached to **superbot-backend** / mint-engine.

## Step 3 — Migrate

```bash
npm run build
npm run db:migrate
npm run db:verify-mint
```

`db:verify-mint` checks mint tables and the **`NonceLock_active_nonce_unique`** partial index. If `db:migrate` fails, capture the **exact** Prisma error, stop, and fix forward (no ad-hoc production DDL unless explicitly approved).

## Step 4 — Seed smoke identities

Set (no private keys):

```text
SMOKE_GUILD_DISCORD_ID   = your Discord server snowflake
SMOKE_USER_DISCORD_ID    = your Discord user snowflake
SMOKE_WALLET_ADDRESS     = 0x… authorized test wallet (lowercase)
SMOKE_CHAIN_ID           = 1   (or target chain)
DATABASE_URL             = same as mint-engine
```

```bash
npm run seed:mint-smoke
```

This upserts `Guild`, `User`, `MintWallet` (`signerType: simulation-only`, `isExecutionEnabled: false`), and `MintWalletAuthorization` with `preflight`, `prepare`, `schedule`, `*`. It does **not** touch `User.encryptedPrivateKey`.

## Step 5 — Mint-engine env (prepare-only)

Set at least:

- `MINT_EXECUTION_ENABLED=false`
- `MINT_MAINNET_BROADCAST_ENABLED=false`
- `MINT_ENGINE_MODE=prepare` (or `simulation`)
- `MINT_TESTNET_ONLY=true` unless you intentionally use mainnet read-only
- `MINT_ENGINE_RPC_URL` (HTTPS JSON-RPC)
- `OPENSEA_API_KEY`
- `MINT_ENGINE_SERVICE_SECRET` (shared with smoke script + executor bot)
- `DATABASE_URL`, `REDIS_URL` (or Redis reachable from the engine)

Health checks (no HMAC on these routes if mounted outside `/v1/mint` — use your deployment’s URLs):

- `GET /health/mint-engine`
- `GET /health/mint-providers`
- `GET /health/mint-clock`
- `GET /metrics`

## Step 6 — Smoke CLI

See [smoke-mint-preflight.md](./smoke-mint-preflight.md). Run **without** `--skip-job` after seed.

## Step 7 — Discord

Use mint-executor-bot `/mint-preflight` and `/mint-result` with the same job id; fields are documented in the mint-embeds implementation.

## Verdict

Only claim **“Prepare-only beta ready”** after a real SeaDrop public collection passes with RPC + OpenSea, persisted `MintJob` / `MintSimulation`, `unsignedPrepare`, Discord parity, and **no** signing or `eth_sendRawTransaction`.

Otherwise: **Phase 3 advanced, prepare-only beta not yet proven.**
