# SuperBot / Supermint Mint Execution Readiness Report

**Generated:** 2026-05-13 (repo + linked Railway snapshot)  
**Repo HEAD:** `b55bd8898b581fde58940a362101a3de5381f02d` on `master`  
**Git working tree:** clean (`master...origin/master` aligned at time of audit)

This document is an **operator-facing audit**. It does **not** print secret values. **Production** truth for env vars and `/mint-status` lines must still be verified in **Railway** and **Discord** by the operator.

---

## 1. Executive Summary

**What the mint system is**  
A controlled pipeline to **plan**, **simulate**, optionally **dry-run on mainnet RPC**, and under strict gates **broadcast** NFT mint–related transactions — with **auditing**, **nonce discipline**, and **admin-only** Discord controls.

**What SuperBot (intelligence) does**  
The main stack (`superbot-backend`, workers, indexers, etc.) focuses on **alerts**, **wallet/collection tracking**, **analytics**, and **opportunity-style signals**. **`mint-*` slash commands are intentionally not registered** on that Discord application; execution UX lives on **Supermint** only.

**What Supermint / `mint-executor-bot` does**  
A **separate Discord application** exposes mint-only slash commands (`/mint-status`, `/mint-preflight`, …). It calls **mint-engine** over HTTPS with **HMAC** for protected routes.

**What mint-engine does**  
HTTP API (`/v1/mint/*` HMAC, public `GET /health/mint-engine`), **job lifecycle**, **preflight**, **policy / mainnet beta gates**, **signer adapter**, **nonce lock**, **broadcast**, **result tracking**, Prisma persistence.

**Current stage (confirmed in thread + codebase)**  

| Area | State |
|------|--------|
| Built | Yes — monorepo builds (`npm run build` includes `clean-dist` + `verify-mint-engine-dist`). |
| Deployed (linked Railway) | **mint-engine** and **mint-executor-bot** latest deployment meta showed **`b55bd88`** / `SUCCESS` / `RUNNING` at audit time. |
| Commands restored | Yes — **14** canonical slash modules in source + `EXPECTED_MINT_EXECUTOR_COMMAND_NAMES`. |
| `/mint-status` | Fixed — no `undefined`; readiness + blockers from merged health + POST `/status`. |
| Mainnet proof | **Not claimed complete** in this document — requires operator evidence (signer, approvals, dry-run, tx proof). |

**Current final verdict (pick one)**  

**Status fixed; commands restored; signer configuration next** — *unless* `/mint-status` already shows **`Signer configured: true`** and **Mainnet proof readiness: ready**; then advance to **wallet approval / dry-run** per the readiness line and gates below.

---

## 2. Architecture Overview

### Main SuperBot intelligence path

- Services such as **`superbot-backend`**, **`superbot-floor-worker`**, **`superbot-market-indexer`**, **`superbot-sales-indexer`**, **`superbot-clickhouse`**, **`superbot-dashboard`** (names from linked Railway project).
- **Alerts**, **wallet/collection tracking**, **analytics**, **opportunity-style flows**.
- **No mint slash UX** on the main bot app (`apps/bot` excludes `mint-*` command loading).

### Supermint / `mint-executor-bot`

- **Dedicated Discord app** — token should be **`MINT_EXECUTOR_DISCORD_TOKEN`** (not `DISCORD_TOKEN`).
- Slash surface (canonical names in repo):
  - `/mint-status` — engine health + merge status + **mainnet proof readiness**.
  - `/mint-preflight`, `/mint-result`, `/mint-jobs`, `/mint-settings`, `/mint-schedule`, `/mint-copy-wallet`, `/mint-stop`
  - `/mint-approve`, `/mint-revoke`, `/mint-approvals` *(legacy `mint-approve-wallet` / `mint-revoke-wallet` names were removed; loader skips stray `*-wallet` files in `dist`)*  
  - `/mint-emergency-stop`, `/mint-emergency-resume`, `/mint-confirm-mainnet`

### Mint-engine

- **HTTP**: `GET /health/mint-engine` (public, `healthSchemaVersion: 2`), `POST /v1/mint/*` **HMAC**.
- **Job creation**, **preflight**, **mainnet dry-run path**, **live path** behind **`mainnetGuard` / `ExecutionPolicyEngine` / beta gates**.
- **Signer** via **`SignerAdapter`** (no `User.encryptedPrivateKey` in engine — enforced by test).
- **Nonce lock**, **broadcast engine**, **result tracker**, **audit log** hooks.

### Database (Prisma / Postgres)

Models present in `packages/database/prisma/schema.prisma` include:  
`MintWallet`, `MintWalletAuthorization`, `CopyMintConfig`, `MintJob`, `MintDrop`, `NonceLock`, `MintTransaction`, `MintSimulation`, `MintAuditLog`, `TrackedMintTrigger`, `MintProviderHealth`, `MintMainnetReadiness`, `MainnetExecutionApproval`, `MintEngineRuntimeState`.

### Redis / queues

- **BullMQ / Redis** used for mint-engine service auth nonce replay (`MINT_API_*`), queues for workers as configured.
- Exact queue names are internal to `@superbot/queue`; mint-engine wires workers on startup.

---

## 3. Current Deployment Status

### Repo

| Item | Value |
|------|--------|
| Branch | `master` |
| Latest commit | `b55bd8898b581fde58940a362101a3de5381f02d` |
| Pushed | Yes (`master...origin/master` clean) |
| Uncommitted changes | None at audit time |

### Railway (linked project snapshot via `railway status --json`, 2026-05-13)

| Service | SERVICE_TYPE (operator sets on Railway) | Deployed | Healthy | Latest commit (Git) | Notes |
|---------|----------------------------------------|----------|---------|----------------------|--------|
| **superbot-mint-engine** | `mint-engine` | Yes | `SUCCESS`, instance `RUNNING` | `b55bd88` | Public URL pattern: `superbot-mint-engine-production.up.railway.app` |
| **superbot-mint-executor-bot** | `mint-executor-bot` | Yes | `SUCCESS`, `RUNNING` | `b55bd88` | Discord bot — may have **no** HTTP service domain |
| **superbot-backend** | typically `api` / router | Yes | `SUCCESS`, `RUNNING` | `b55bd88` | Main API host in snapshot |
| **superbot-floor-worker** | `floor-worker` | Yes | `SUCCESS` | `b55bd88` | |
| **superbot-market-indexer** | `market-indexer` | Yes | `SUCCESS` | `b55bd88` | |
| **superbot-sales-indexer** | `sales-indexer` | Yes | `SUCCESS` | `b55bd88` | |
| **superbot-clickhouse** | n/a | Yes | `SUCCESS` | `b55bd88` | |
| **superbot-dashboard** | n/a | Yes | `SUCCESS` | `b55bd88` | |
| **Redis** | n/a | Yes | `SUCCESS` | image deploy | Password auth per Railway template |
| **Postgres** | n/a | Yes | `SUCCESS` | image deploy | Managed DB service |

**Interpretation:** **mint-engine** and **mint-executor-bot** were on the **same commit as local `master`** at audit time. Re-check after any new push: `npx @railway/cli status --json` or Railway UI → Deployments.

---

## 4. Environment Configuration Review

Values below describe **what must exist** and **template defaults** from `production.env.example`. **Do not commit real `.env`.** In Railway, confirm each variable **is set** (never paste values into tickets).

### Mint-engine (representative)

| Variable | Service | Present (template) | Safe / policy | Notes |
|----------|---------|-------------------|---------------|--------|
| `SERVICE_TYPE` | mint-engine | Documented | safe when `mint-engine` | Wrong `SERVICE_TYPE` → wrong process |
| `MINT_ENGINE_MODE` | mint-engine | `prepare` in example | policy | `live` only when deliberately going live |
| `MINT_EXECUTION_ENABLED` | mint-engine | `false` in example | safer default | Must be `true` for live execution path |
| `MINT_MAINNET_BROADCAST_ENABLED` | mint-engine | `false` in example | safer default | Must be `true` for mainnet broadcast |
| `MINT_TESTNET_ONLY` | mint-engine | `true` in example | blocks mainnet when true | Must be `false` for mainnet proof |
| `MINT_MAINNET_BETA` | mint-engine | *(see mintEnv defaults)* | policy | Controlled beta master switch |
| `MINT_MAINNET_DRY_RUN` | mint-engine | *(env)* | policy | Dry-run on mainnet RPC without broadcast |
| `MINT_REQUIRE_SECURE_SIGNER` | mint-engine | `true` in example | safe | Stricter signer expectations |
| `MINT_EMERGENCY_STOP` | mint-engine | `false` in example | safe | Stops execution when true |
| `MINT_MAINNET_MAX_ACTIVE_JOBS` | mint-engine | default `1` in code | safe | Single-flight style cap |
| `MINT_MAINNET_MAX_QUANTITY` | mint-engine | default `1` in code | safe | |
| `MINT_MAINNET_COPY_LIVE_ENABLED` | mint-engine | default false in code | safe | Must stay off for proof policy |
| `MINT_MAINNET_PRIVATE_RELAY_ENABLED` | mint-engine | default false in code | safe | |
| `MINT_MAINNET_AUTO_REPLACE_ENABLED` | mint-engine | default false in code | safe | |
| `MINT_MAINNET_REQUIRE_MANUAL_CONFIRMATION` | mint-engine | default true in code | safe | |
| `DATABASE_URL` | mint-engine | required in prod | secret | Never log |
| `REDIS_URL` / Redis | mint-engine | required for HMAC replay | secret | |
| `MINT_ENGINE_RPC_URL` / RPC fallbacks | mint-engine | required for chain work | secret URLs | |
| `OPENSEA_API_KEY` | mint-engine | optional | secret | Drop resolution |
| `MINT_ENGINE_SERVICE_SECRET` | mint-engine | required | secret | Shared with executor for HMAC |

### Mint-executor-bot

| Variable | Service | Present (template) | Safe | Notes |
|----------|---------|-------------------|------|--------|
| `SERVICE_TYPE` | executor | Documented | `mint-executor-bot` | |
| `MINT_EXECUTOR_DISCORD_TOKEN` | executor | placeholder | secret | Must **not** be main `DISCORD_TOKEN` |
| `MINT_ENGINE_URL` | executor | example internal URL | non-secret host only | Executor `mint-status` **requires** this |
| `MINT_ENGINE_SERVICE_SECRET` | executor | placeholder | secret | Must match engine |
| `MINT_EXECUTOR_GUILD_ID` | executor | commented | optional | Guild slash = fast updates |
| `MINT_EXECUTOR_DISCORD_APPLICATION_ID` | executor | commented | optional | If set, must match token app id |
| `MINT_EXECUTOR_REGISTER_GLOBAL_COMMANDS` | executor | commented | optional | Defaults guild-only when guild id set |
| `MINT_ADMIN_DISCORD_IDS` | engine + executor | operator | non-secret ids | Admin slash + engine admin routes |
| `MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS` | engine | `false` in example | safe | SuperBot must not own mint slash |

---

## 5. Mint Status Output (`/mint-status`)

**This audit cannot paste your live Discord embed.** Run **`/mint-status`** in the **Supermint** server and compare to the structure below.

### Expected sections (from `mintStatusDisplay` + merged payloads)

```markdown
Engine reachable: yes
Engine detail merge (POST /v1/mint/status): ok | auth failed (HTTP …) | failed | skipped
…
Mode: …
Live execution flag: …
Mainnet broadcast: …
Mainnet beta: …
Mainnet dry-run: …
Emergency stop: …
Runtime emergency DB: true | false
Testnet only: …
Signer configured: …
Default chain id: …
Copy-mint live: …
Private relay: …
Auto replace: …
Manual confirmation: …
Max active jobs: …
Max quantity: …
Health schema: 2
… (payload incomplete warning if applicable)
Mainnet proof readiness: ready | not ready
First blocker: …
```

### Checklist

| Question | Expected after recent fixes |
|----------|----------------------------|
| Does `/mint-status` show `undefined`? | **No** |
| Does it show `missing` for required fields? | **Only if** engine/merge incomplete or POST auth failed |
| Does it show readiness? | **Yes** — `Mainnet proof readiness` + `First blocker` |
| Current first blocker? | **Operator must read live embed** — often **`signer not configured`** until signer is wired and `signerConfigured` is true |

---

## 6. Discord Command Surface

### Source (`EXPECTED_MINT_EXECUTOR_COMMAND_NAMES`)

| Command | Source exists | Registered in Discord | Working | Notes |
|---------|---------------|----------------------|---------|--------|
| `/mint-status` | Yes | Expect **yes** after deploy | Expect **yes** | Merges GET health + POST `/status` |
| `/mint-preflight` | Yes | Expect yes | Operator verify | |
| `/mint-result` | Yes | Expect yes | Operator verify | |
| `/mint-jobs` | Yes | Expect yes | Operator verify | |
| `/mint-settings` | Yes | Expect yes | Admin-gated | |
| `/mint-schedule` | Yes | Expect yes | Operator verify | |
| `/mint-copy-wallet` | Yes | Expect yes | Operator verify | |
| `/mint-stop` | Yes | Expect yes | Operator verify | |
| `/mint-approve` | Yes | Expect yes | **Admin** + HMAC to engine | Replaces legacy **`mint-approve-wallet`** |
| `/mint-revoke` | Yes | Expect yes | Admin | Replaces **`mint-revoke-wallet`** |
| `/mint-approvals` | Yes | Expect yes | Admin | Lists approvals |
| `/mint-emergency-stop` | Yes | Expect yes | Admin | |
| `/mint-emergency-resume` | Yes | Expect yes | Admin | |
| `/mint-confirm-mainnet` | Yes | Expect yes | Admin | |

**If a command is missing in Discord:** check **wrong bot token**, **`MINT_EXECUTOR_DISCORD_APPLICATION_ID` mismatch** (registration skipped), **`MINT_EXECUTOR_REGISTER_SLASH_COMMANDS=false`**, **guild vs global** delay, or **Railway not on latest commit**.

---

## 7. Database and Migration Status

| DB object | Present in Prisma schema | Verified in live Postgres |
|-----------|-------------------------|----------------------------|
| `MintWallet` | Yes | **Operator:** run `npm run db:verify-mint` with prod `DATABASE_URL` |
| `MintWalletAuthorization` | Yes | same |
| `CopyMintConfig` | Yes | same |
| `MintJob` | Yes | same |
| `MintDrop` | Yes | same |
| `NonceLock` | Yes | same + expect partial unique index `NonceLock_active_nonce_unique` |
| `MintTransaction` | Yes | same |
| `MintSimulation` | Yes | same |
| `MintAuditLog` | Yes | same |
| `TrackedMintTrigger` | Yes | same |
| `MintProviderHealth` | Yes | same |
| `MintMainnetReadiness` | Yes | same (readiness checklist rows) |
| `MainnetExecutionApproval` | Yes | same |
| `MintEngineRuntimeState` | Yes | same (`emergencyStop` runtime) |

**Commands (operator)**  

```bash
npm run db:migrate
npm run db:verify-mint
npm run db:identity
```

This audit **did not** execute `db:verify-mint` against production (no `DATABASE_URL` in this session).

---

## 8. Mainnet Policy and Safety Gates

Evidence references: `mainnetGuard.ts`, `ExecutionPolicyEngine.ts`, `evaluateMainnetStrict` tests, `MintExecutionEngine`, `SignerAdapter`, `BroadcastEngine`, `mintEnv.ts`, HTTP routes for approvals / emergency.

| Safety gate | Enforced | Evidence | Residual risk |
|---------------|----------|----------|----------------|
| Mainnet blocked unless strict policy | Yes | `mainnetGuard` + policy tests | Mis-set env in prod |
| `MINT_MAINNET_BETA` required for controlled live | Yes | `mintEnv` + beta tests | Operator disables beta by mistake |
| `MINT_MAINNET_BROADCAST_ENABLED` | Yes | guard + env | |
| `MINT_TESTNET_ONLY` must be false for mainnet | Yes | tests / guard | |
| Wallet approval record | Yes | `MainnetExecutionApproval` + queries | Wrong guild/user scope |
| Signer approval flags | Yes | `MINT_MAINNET_SIGNER_APPROVED` etc. | Signer not approved |
| Gas caps (`MINT_MAX_*`) | Yes | `mintGasCapsConfigured` / policy | Caps unset → block |
| Max quantity / active jobs | Yes | env + job creation tests | |
| Emergency stop (env + DB) | Yes | `emergencyRuntime` + health | |
| Manual confirmation | Yes | `MINT_MAINNET_REQUIRE_MANUAL_CONFIRMATION` | |
| Collection allow-list (approval) | Yes | approval query tests | |
| No copy-mint live on mainnet (policy) | Yes | policy tests | |
| No private relay by default | Yes | env defaults + policy | |
| No auto-replace by default | Yes | env defaults + policy | |
| No `User.encryptedPrivateKey` in engine | Yes | `liveExecutionPolicy.test.ts` | |
| No seed phrase via Discord UX | Policy / product | Executor commands do not collect seeds | Social engineering |

---

## 9. Signer Status

**Is signer configured?**  
Determined at runtime by **`SignerAdapter.signerConfigured()`** and surfaced in **`GET /health/mint-engine`** and `/mint-status`. **Operator must read live `/mint-status`.**

**Expected signer types**  
Controlled by env such as **`MINT_REQUIRE_SECURE_SIGNER`**, optional local-dev paths, and **`MINT_MAINNET_SIGNER_APPROVED`** / **`MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED`** for mainnet live (see `mintEnv` + `mintRoutes` `/status` fields `signerMode`, `signerMainnetApproved`).

**Does signer avoid `User.encryptedPrivateKey`?**  
**Yes** — enforced by automated test that the engine module does not reference it.

**Plan hash, caps, nonce lock, emergency**  
Execution path is designed to **respect policy outputs**, **gas/value caps**, **nonce lock**, and **emergency stop**; detailed line-by-line proof is in engine tests — **production behavior** still needs **operator dry-run / controlled tx** evidence.

### If signer is not configured

**Current blocker:**  
Signer is not configured (or not mainnet-approved). **Mainnet proof cannot proceed** until the operator completes signer setup per your runbook and **`/mint-status`** shows the next readiness state.

**Typical next signer steps (non-secret)**  

1. Choose signer backend (KMS / HSM / approved local-dev path per policy only).  
2. Set required env on **mint-engine** service (no keys in Discord).  
3. Set **`MINT_MAINNET_SIGNER_APPROVED`** (or documented local-dev approval) only when policy allows.  
4. Restart mint-engine; re-run **`/mint-status`** → confirm **`Signer configured: true`** and review **First blocker**.

---

## 10. Execution Flow Readiness (controlled mainnet proof)

| Step | Status | Blocker | Next action |
|------|--------|---------|-------------|
| 1. `/mint-status` | **Ready** (tooling) | Live values | Run in Discord; confirm no `missing` / readiness |
| 2. Signer configured | **Operator** | `signerConfigured` false | Complete signer setup |
| 3. `/mint-approve` (strict caps) | **Not done here** | Admin + policy | One-wallet approval per runbook |
| 4. Mainnet dry-run job | **Not proven here** | RPC, flags | Use engine job API / documented flow |
| 5. Manual confirmation | **Gated** | Job state | `/mint-confirm-mainnet` when appropriate |
| 6. 0 ETH self-transfer | **Not proven here** | — | Optional proof step per your runbook |
| 7. `/mint-result` | **Tooling ready** | Needs real job id | After real job |
| 8. Emergency stop drill | **Tooling ready** | Ops | `/mint-emergency-stop` / resume |
| 9. Document proof | **Not done** | — | Export logs + tx hashes |

---

## 11. What Has Been Covered

- Separate **mint-executor** Discord app; SuperBot does not register `mint-*`.  
- **mint-engine** HTTP server, **HMAC** routes, **public health v2** with full safety fields + `runtimeEmergencyStopAvailable`.  
- **`/mint-status`** fixed (no `undefined`; readiness summary).  
- **14** slash commands restored; **`clean-dist`** prevents stale renamed command JS.  
- **Guild-first** slash registration when `MINT_EXECUTOR_GUILD_ID` set; optional global via `MINT_EXECUTOR_REGISTER_GLOBAL_COMMANDS`.  
- **Mainnet beta / broadcast / testnet-only / emergency / caps / quantity / jobs** policy code + tests.  
- **Mainnet execution approval** model + Discord **approve / revoke / list**.  
- **DB models** for jobs, approvals, runtime emergency, readiness checklist, nonce lock index verification script.  
- **Command loader** diagnostics (per-file import errors, duplicates, expected count).

---

## 12. What Is Not Yet Proven (in this audit)

- **Live production** env values (only Railway knows).  
- **`npm run db:verify-mint`** against production DB from this session.  
- **Signer** actually signing in production with approved configuration.  
- **Wallet approval** end-to-end on prod Discord + DB row.  
- **Mainnet dry-run** job completion in prod.  
- **0 ETH self-transfer** proof (if still in your runbook).  
- **`MintTransaction`** row from a **real** mainnet tx in prod.  
- **`/mint-result`** after real broadcast.  
- **Emergency stop** behavior against running workers in prod.  
- **Public mint / FCFS** stress scenarios — **explicitly out of scope** for first proof.

---

## 13. Immediate Next Steps (ordered)

1. **Open `/mint-status`** on Supermint — copy embed to internal ops doc.  
2. If **First blocker** = signer → complete **signer** setup; restart **mint-engine**.  
3. Re-run **`/mint-status`** until readiness advances (do **not** skip gates).  
4. When policy allows: **`/mint-approve`** with **strict caps** for **one** wallet / user / guild scope.  
5. Run **mainnet dry-run** job per runbook.  
6. If required: **manual confirm** via **`/mint-confirm-mainnet`**.  
7. Optional: **0 ETH self-transfer** proof step.  
8. **`/mint-result`** with real `job_id`.  
9. **`/mint-emergency-stop`** drill + resume.  
10. **Document** hashes, job ids, timestamps, and approvers.

---

## 14. Do Not Do Yet

- Do **not** run a **hyped / FCFS** mint as first proof.  
- Do **not** enable **`MINT_MAINNET_COPY_LIVE_ENABLED`** for mainnet proof.  
- Do **not** enable **`MINT_MAINNET_PRIVATE_RELAY_ENABLED`** without explicit policy.  
- Do **not** approve **multiple** wallets beyond controlled beta scope.  
- Do **not** raise **gas / cost caps** to “make it work”.  
- Do **not** disable **emergency stop** or **manual confirmation**.  
- Do **not** broadcast with **`MINT_TESTNET_ONLY=true`**.  
- Do **not** paste **private keys / seeds** into Discord or tickets.

---

## 15. Final Readiness Verdict

**Status fixed; commands restored; signer configuration next**

**Why:** Code, tests, deployment metadata, and operator thread confirm **status** and **slash commands** are restored and **mint-engine / executor** track **`b55bd88`**. **Mainnet proof** is a **separate operational milestone** that depends on **live signer**, **DB**, **approvals**, and **dry-run / tx evidence** — not asserted complete here.

---

## 16. Operator Checklist

- [ ] `/mint-status` shows **no** `undefined`  
- [ ] All **14** mint slash commands visible in the **Supermint** guild  
- [ ] **`Signer configured: true`** (when policy expects signing)  
- [ ] **One** wallet approved with **strict** caps (`/mint-approve`)  
- [ ] **Mainnet dry-run** passed (logged evidence)  
- [ ] **0 ETH self-transfer** completed *(if in runbook)*  
- [ ] `/mint-result` verified for a **real** job id  
- [ ] `/mint-emergency-stop` tested in a **safe** window  
- [ ] Proof **documented** (no secrets in doc)

---

### Audit artifact

- **Report path:** `docs/current-mint-bot-readiness-report.md`
