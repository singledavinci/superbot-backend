# Mainnet live beta — operator runbook

Controlled **single-wallet** mainnet use only.

## 1. Disable execution immediately

**Mint engine (Railway):**

1. Set `MINT_EMERGENCY_STOP=true` **or** `POST /v1/mint/runtime/emergency-stop` with `adminDiscordId` in `MINT_ADMIN_DISCORD_IDS` (HMAC).
2. Optionally `MINT_EXECUTION_ENABLED=false` and redeploy.

**Executor bot:** pause Railway service `superbot-mint-executor-bot`.

## 2. Emergency stop / resume

- **Stop:** persists `MintEngineRuntimeState.emergencyStop=true` (`id=default`). Effective = **env OR DB**.
- **Resume:** `POST /v1/mint/runtime/emergency-resume` clears DB flag.

Discord: **`/mint-emergency-stop`** / **`/mint-emergency-resume`** — requires **Guild Administrator** and engine **`MINT_ADMIN_DISCORD_IDS`** must include the caller.

## 3. Revoke wallet approval

Update or delete `MainnetExecutionApproval` rows (`approvalStatus` ≠ `active`).

## 4. Rotate signer / HMAC secrets

Rotate `MINT_ENGINE_SERVICE_SECRET`, external signer URL secrets, or `MINT_LOCAL_DEV_PRIVATE_KEY`; redeploy all services that share them.

## 5. Stop Railway service

Pause or scale to zero for `superbot-mint-engine` / executor.

## 6. Inspect `MintJob` / `MintTransaction` / `NonceLock`

Use Prisma Studio or SQL — see `packages/database/prisma/schema.prisma` models.

## 7. Stuck nonce / pending tx

Identify wallet nonce on Etherscan; reconcile `NonceLock` only with documented operator action.

## 8. First mainnet beta checklist

- [ ] `docs/testnet-live-execution-proof.md` completed
- [ ] `MINT_MAINNET_DRY_RUN=true` dry-run job succeeded (`executionMode=mainnet_dry_run`, `chainId=1`)
- [ ] Active `MainnetExecutionApproval` with caps, expiry, allow-list
- [ ] `POST /v1/mint/jobs/confirm-mainnet` for the live job
- [ ] `MINT_MAINNET_SIGNER_APPROVED` / `MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED` as applicable
- [ ] `MINT_MAINNET_BETA_*` env matches single guild/user/wallet
- [ ] Prefer **0 ETH self-transfer** or lowest-risk path first
