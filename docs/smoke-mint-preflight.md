# Smoke test: mint preflight (prepare-only beta proof)

**Before first smoke on Railway:** migrate DB, seed identities, and confirm secrets — see [mint-smoke-production.md](./mint-smoke-production.md). If Railway JSON dumps ever existed on disk, delete them and rotate credentials (do not commit dumps).

This proves the **real** SeaDrop public path: OpenSea official contract API + on-chain RPC via `mint-engine`, with **no signing** and **no broadcasting**.

## Database prerequisite

The mint-engine preflight API **requires** existing rows in **`Guild`**, **`User`**, and **`MintWallet`** (and uses `MintJob` / `MintSimulation` when not using `--skip-job`). Your Postgres database must include the mint Prisma models (run migrations against the same `DATABASE_URL` the engine uses):

```bash
# From repo root, against the target DATABASE_URL
set DATABASE_URL=postgresql://...
npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
```

If `MintWallet` does not exist yet, smoke will fail until migrations are applied and at least one mint wallet is seeded.

## Operator environment (mint-engine host)

Set on the process that runs `mint-engine`:

| Variable | Required | Notes |
|----------|----------|--------|
| `MINT_ENGINE_RPC_URL` | Yes | HTTPS JSON-RPC for the target chain |
| `OPENSEA_API_KEY` | Yes | Official OpenSea API key for `api.opensea.io` |
| `MINT_ENGINE_SERVICE_SECRET` | Yes | Shared secret with clients (HMAC) |
| `MINT_EXECUTION_ENABLED` | Recommended `false` | No live execution |
| `MINT_ENGINE_MODE` | `simulation` or `prepare` | |
| `MINT_MAINNET_BROADCAST_ENABLED` | `false` | |
| `MINT_TESTNET_ONLY` | `true` unless you intentionally use mainnet read-only | |

## Operator environment (smoke script host)

| Variable | Required | Notes |
|----------|----------|--------|
| `MINT_ENGINE_URL` | No | Default `http://127.0.0.1:3847` |
| `MINT_ENGINE_SERVICE_SECRET` | Yes | Same as engine |
| `SMOKE_GUILD_DISCORD_ID` | Yes* | Guild snowflake that exists in `Guild.discordId` |
| `SMOKE_USER_DISCORD_ID` | Yes* | User snowflake that exists in `User.discordId` |
| `SMOKE_CHAIN_ID` | No | Default `1` |

\*Required for preflight (engine validates guild/user/wallet). For **MintJob + MintSimulation** persistence, the same IDs must match a `MintWallet` row for `--wallet`.

## Example collection (Ethereum, SeaDrop-style)

| Collection | OpenSea slug | NFT contract (Ethereum) |
|-------------|--------------|-------------------------|
| Swol Mfers | `swol-mfer` | `0xfba6b20e81527a4ca21c614e800d914eac88ff1c` |

Resolve the contract from OpenSea with an API key: `GET https://api.opensea.io/api/v2/collections/swol-mfer` → `contracts[0].address`.

## Script

```bash
npm run smoke:mint-preflight -- \
  --contract <REAL_SEADROP_COLLECTION_0x> \
  --wallet <AUTHORIZED_MINT_WALLET_0x> \
  --quantity 1 \
  --mode prepare \
  --chain-id 1
```

Omit job persistence (HTTP preflight only, no `MintJob`):

```bash
npm run smoke:mint-preflight -- --contract 0x... --wallet 0x... --mode prepare --skip-job
```

`--skip-job` is only useful when you cannot create a job; **full proof** requires job + `persistJobId` so `planHash`, `MintSimulation`, and job metadata are written.

## cURL example (HMAC)

The body must be byte-identical to what was signed. Example minimal JSON (replace IDs and addresses):

```bash
export SECRET='your-mint-engine-service-secret'
export BASE='http://127.0.0.1:3847'
export PATH_ONLY='/v1/mint/preflight'
export TS=$(date +%s)
export NONCE=$(openssl rand -hex 16)
export BODY='{"guildDiscordId":"YOUR_GUILD_SNOWFLAKE","userDiscordId":"YOUR_USER_SNOWFLAKE","walletAddress":"0xYOUR_WALLET","collectionAddress":"0xCOLLECTION","dropSource":"opensea","chainId":1,"quantity":1,"executionMode":"prepare"}'
# SHA256 of body (hex), then HMAC — easiest path is to use the Node script above.
```

Recommended: use `npm run smoke:mint-preflight` which applies the same signing algorithm as `mint-executor-bot` (`method\\npath\\nts\\nnonce\\nsha256(body)`).

## Verdict

Only report **“Prepare-only beta ready”** after a real collection passes end-to-end with RPC + OpenSea, `unsignedPrepare` present, simulation `PASS` or `PASS_STAGE_NOT_OPEN_YET`, `MintJob` / `MintSimulation` rows created when using job persistence, and Discord `/mint-preflight` + `/mint-result` show the same fields.
