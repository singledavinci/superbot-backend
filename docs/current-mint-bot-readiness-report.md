# SuperBot / Supermint Mint Execution Readiness Report

**Report refreshed:** 2026-05-13  
**Repository:** `master` @ **`d98e841`** (report refresh commit; mint code changes land in **`b55bd88`** / **`65678be`** / **`9be8350`** ancestry)  
**Working tree:** clean vs `origin/master` at refresh time  

This is an **operator audit**. **No secret values** are printed. **Production** env and **`/mint-status`** text must be confirmed in **Railway** and **Discord** by the operator.

---

## 1. Executive Summary

**What the mint system is**  
A **controlled** execution stack: **preflight**, **simulation**, optional **mainnet dry-run** (RPC without unsafe broadcast), and **live** mainnet only when **policy**, **caps**, **approvals**, **signer**, and **operator controls** all align — with **Prisma auditability**, **nonce locking**, and **emergency stop**.

**What SuperBot does**  
The **intelligence** side: **alerts**, **wallet tracking**, **collection tracking**, **analytics**, **opportunity-style signals**. It does **not** own mint slash UX by design (`mint-*` is **not** loaded on `apps/bot`).

**What Supermint / `mint-executor-bot` does**  
A **separate Discord application** (Supermint) exposes **mint-only** slash commands. It calls **mint-engine** over HTTPS; protected routes use **HMAC** (`MINT_ENGINE_SERVICE_SECRET`).

**Current stage**

| Milestone | State |
|-----------|--------|
| **Built** | Yes — `npm run build` runs Prisma generate, **`clean-dist`**, `tsc`, **`verify-mint-engine-dist`**. |
| **Deployed** | Linked **Railway** showed **mint-engine** and **mint-executor-bot** on Git commit **`9be8350`** with **`SUCCESS`** / **`RUNNING`** at last CLI check (re-verify after any deploy). |
| **Commands restored** | Yes — **14** commands in `EXPECTED_MINT_EXECUTOR_COMMAND_NAMES` under `apps/mint-executor-bot/src/commands`. |
| **Status working** | Yes — `/mint-status` uses merged **GET `/health/mint-engine`** + **POST `/v1/mint/status`**; **no `undefined`**; **readiness + first blocker** lines. |
| **Mainnet proof** | **Not completed in this report** — requires operator evidence (signer, approvals, dry-run, optional self-transfer, tx/receipt proof). |

**Current final verdict (exactly one)**

**Status fixed; commands restored; signer configuration next**

If **`/mint-status`** already shows **`Signer configured: true`** and readiness moves on, the operator should re-pick the verdict from the remaining options (**wallet approval → dry-run → proof → beta live**) using the **First blocker** line as ground truth — this static document cannot know live prod signer state.

---

## 2. Architecture Overview

### Main SuperBot intelligence bot

- **Alerts** and delivery pipelines  
- **Wallet** and **collection** tracking  
- **Analytics** and indexing workers  
- **Opportunity-style** detection and scoring  
- **No mint execution slash UX** on the main bot app (mint commands live only on Supermint)

### Supermint / `mint-executor-bot`

Mint-only Discord UX (names as operators know them; **current slash names** in repo are in parentheses where renamed):

- `/mint-status`  
- `/mint-preflight`  
- `/mint-result`  
- `/mint-jobs`  
- `/mint-settings`  
- `/mint-schedule`  
- `/mint-copy-wallet`  
- `/mint-stop`  
- **`/mint-approve-wallet`** → **canonical:** **`/mint-approve`**  
- **`/mint-revoke-wallet`** → **canonical:** **`/mint-revoke`**  
- **`/mint-approvals`** (list active approvals)  
- `/mint-emergency-stop`  
- `/mint-emergency-resume`  
- `/mint-confirm-mainnet`  

### Mint-engine

- **HTTP API** — public **`GET /health/mint-engine`** (`healthSchemaVersion: 2`); **`POST /v1/mint/*`** with **HMAC**  
- **Job creation** and persistence  
- **Preflight** and simulation path  
- **Mainnet dry-run** path (policy-gated)  
- **Live execution** behind **mainnet beta / broadcast / testnet / caps / approval / signer** gates  
- **Policy engine** (`ExecutionPolicyEngine`, `mainnetGuard`, env from `mintEnv`)  
- **Signer integration** (`SignerAdapter` — compares **`planHash`** to **`approvedPlanHash`** on sign path)  
- **Nonce lock** (`NonceLock` + partial unique index verified by `db:verify-mint`)  
- **Broadcast engine** + **result tracker** + **audit** hooks  

### Database

- **Prisma** + **Postgres**  
- **Mint tables** (wallets, jobs, drops, simulations, transactions, audit, provider health, readiness checklist)  
- **MainnetExecutionApproval** (wallet approval records)  
- **MintEngineRuntimeState** (runtime emergency flag)  

### Redis / queues

- **Redis** for **HMAC nonce replay** protection and **BullMQ** job infrastructure (see `@superbot/queue`)  
- **Mint execution workers** started with mint-engine HTTP server  
- **Trigger / delivery** queues exist for broader SuperBot stack where configured — mint-engine focuses on mint job execution and related workers  

---

## 3. Current Deployment Status

### Git

| Check | Value |
|--------|--------|
| **Current branch** | `master` |
| **Latest commit hash** | `d98e841` (pushed) |
| **Pushed** | Yes (`master...origin/master` clean at refresh) |
| **Uncommitted changes** | None |

### Railway (linked project; `npx @railway/cli status --json`, refreshed 2026-05-13)

Application services below show **Git `commitHash`** from **`singledavinci/superbot-backend`** (Postgres/Redis use image deploy SHAs — not comparable to app commits).

| Service | SERVICE_TYPE | Deployed | Healthy | Latest commit | Notes |
|---------|----------------|----------|---------|---------------|--------|
| **superbot-mint-engine** | `mint-engine` | Yes | `SUCCESS`, `RUNNING` | `9be835087331f10749022dacb251d49aabf32219` | e.g. `superbot-mint-engine-production.up.railway.app` |
| **superbot-mint-executor-bot** | `mint-executor-bot` | Yes | `SUCCESS`, `RUNNING` | `9be835087331f10749022dacb251d49aabf32219` | Discord bot; may have empty `serviceDomains` |
| **superbot-backend** | `api` (typical) | Yes | `SUCCESS`, `RUNNING` | `9be835087331f10749022dacb251d49aabf32219` | Main intelligence/API surface in this project |
| **superbot-floor-worker** | `floor-worker` | Yes | `SUCCESS` | `9be835087331f10749022dacb251d49aabf32219` | |
| **superbot-market-indexer** | `market-indexer` | Yes | `SUCCESS` | `9be835087331f10749022dacb251d49aabf32219` | |
| **superbot-sales-indexer** | `sales-indexer` | Yes | `SUCCESS` | `9be835087331f10749022dacb251d49aabf32219` | |
| **superbot-clickhouse** | n/a | Yes | `SUCCESS` | `9be835087331f10749022dacb251d49aabf32219` | |
| **superbot-dashboard** | n/a | Yes | `SUCCESS` | `9be835087331f10749022dacb251d49aabf32219` | |
| **Redis** | n/a | Yes | `SUCCESS` | *(image)* | |
| **Postgres** | n/a | Yes | `SUCCESS` | *(image)* | |

**Recent redeploy:** mint-engine and mint-executor-bot deployments were tied to **`9be8350`** at CLI refresh — confirm timestamps in Railway UI after any new push.

---

## 4. Environment Configuration Review

**Legend — `Present`:** `set` = present in Railway template / expected; **`verify`** = operator must confirm in Railway without pasting values. **`Safe value`** = policy direction, not a literal secret.

### Mint-engine

| Variable | Service | Present | Safe value | Notes |
|----------|---------|---------|------------|--------|
| `SERVICE_TYPE` | mint-engine | verify | `mint-engine` | Wrong value → wrong process |
| `MINT_ENGINE_MODE` | mint-engine | verify | `prepare` / `simulation` / `live` per phase | `live` only when deliberately going live |
| `MINT_EXECUTION_ENABLED` | mint-engine | verify | `false` until ready; `true` when executing | |
| `MINT_MAINNET_BROADCAST_ENABLED` | mint-engine | verify | `false` until mainnet proof phase | |
| `MINT_TESTNET_ONLY` | mint-engine | verify | `true` for testnet phase; **`false`** for mainnet proof | |
| `MINT_MAINNET_BETA` | mint-engine | verify | `true` for controlled beta when intended | |
| `MINT_MAINNET_DRY_RUN` | mint-engine | verify | per runbook | |
| `MINT_REQUIRE_SECURE_SIGNER` | mint-engine | verify | `true` recommended | |
| `MINT_EMERGENCY_STOP` | mint-engine | verify | `false` for normal ops | |
| `MINT_MAINNET_MAX_ACTIVE_JOBS` | mint-engine | verify | **`1`** for beta | code default `1` |
| `MINT_MAINNET_MAX_QUANTITY` | mint-engine | verify | **`1`** for beta | code default `1` |
| `MINT_MAINNET_COPY_LIVE_ENABLED` | mint-engine | verify | **`false`** | |
| `MINT_MAINNET_PRIVATE_RELAY_ENABLED` | mint-engine | verify | **`false`** | |
| `MINT_MAINNET_AUTO_REPLACE_ENABLED` | mint-engine | verify | **`false`** | |
| `MINT_MAINNET_REQUIRE_MANUAL_CONFIRMATION` | mint-engine | verify | **`true`** | |
| `DATABASE_URL` | mint-engine | verify | set, never logged | secret |
| `REDIS_URL` | mint-engine | verify | set | secret |
| `MINT_ENGINE_RPC_URL` | mint-engine | verify | set for chain ops | often secret URL |
| `OPENSEA_API_KEY` | mint-engine | verify | optional | secret |
| `MINT_ENGINE_SERVICE_SECRET` | mint-engine | verify | set; must match executor | secret |

### Mint-executor-bot

| Variable | Service | Present | Safe value | Notes |
|----------|---------|---------|------------|--------|
| `SERVICE_TYPE` | executor | verify | `mint-executor-bot` | |
| `MINT_EXECUTOR_DISCORD_TOKEN` | executor | verify | Supermint app only | secret; do not reuse main `DISCORD_TOKEN` |
| `MINT_ENGINE_URL` | executor | verify | HTTPS/internal URL to mint-engine | required for `/mint-status` |
| `MINT_ENGINE_SERVICE_SECRET` | executor | verify | matches engine | secret |
| `MINT_EXECUTOR_GUILD_ID` | executor | verify | set for guild commands | optional but recommended for fast slash refresh |
| `MINT_EXECUTOR_DISCORD_APPLICATION_ID` | executor | verify | matches token app id if set | mismatch → registration skipped |
| `MINT_ADMIN_DISCORD_IDS` | engine + executor | verify | set for admin Discord routes / slash admin | non-secret ids |
| `MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS` | mint-engine | verify | **`false`** on intelligence path | prevents wrong mental model |

---

## 5. Mint Status Output

**Operator action:** run **`/mint-status`** in Discord and **paste the embed text** into your internal ops log. The template below matches **`buildMintStatusDescription`** output shape.

```
Engine reachable: yes | no (+ reason if env missing)
Engine detail merge (POST /v1/mint/status): ok | auth failed (HTTP …) | failed | skipped (…)

Mode: …
Live execution flag: …
Mainnet broadcast: …
Mainnet beta: …
Mainnet dry-run: …
Emergency stop: …
Runtime emergency DB: …
Testnet only: …
Signer configured: …
Default chain id: …
Copy-mint live: …
Private relay: …
Auto replace: …
Manual confirmation: …
Max active jobs: …
Max quantity: …
Health schema: …

[If incomplete payload:]
Status payload incomplete. Do not run mainnet proof.
Required fields: …
mainnetProofReady: false

Mainnet proof readiness: ready | not ready
First blocker: …
```

**Questions**

| Question | Answer (expected after fixes) |
|----------|-------------------------------|
| Does `/mint-status` show **`undefined`**? | **No** |
| Does it show **`missing`** fields? | **Only if** health incomplete or POST merge failed |
| Does it show **readiness**? | **Yes** |
| **Current first blocker?** | **Operator must read live `First blocker:` line** — commonly **`signer not configured`** until signer is live and `signerConfigured` is true |

---

## 6. Discord Command Surface

| Command | Source exists | Registered in Discord | Working | Notes |
|---------|---------------|----------------------|---------|--------|
| `/mint-status` | Yes | verify | verify | |
| `/mint-preflight` | Yes | verify | verify | |
| `/mint-result` | Yes | verify | verify | |
| `/mint-jobs` | Yes | verify | verify | |
| `/mint-settings` | Yes | verify | verify | Admin |
| `/mint-schedule` | Yes | verify | verify | |
| `/mint-copy-wallet` | Yes | verify | verify | |
| `/mint-stop` | Yes | verify | verify | |
| `/mint-approve-wallet` **or** `/mint-approve` | **`/mint-approve` only** in repo | verify | verify | Legacy **`-wallet`** slash **removed**; use **`/mint-approve`** |
| `/mint-revoke-wallet` **or** `/mint-revoke` | **`/mint-revoke` only** in repo | verify | verify | Legacy **`-wallet`** removed |
| `/mint-approvals` | Yes | verify | verify | Admin |
| `/mint-emergency-stop` | Yes | verify | verify | Admin |
| `/mint-emergency-resume` | Yes | verify | verify | Admin |
| `/mint-confirm-mainnet` | Yes | verify | verify | Admin |

**If missing:** wrong **Discord app token**, **`MINT_EXECUTOR_DISCORD_APPLICATION_ID`** mismatch → registration skipped; **`MINT_EXECUTOR_REGISTER_SLASH_COMMANDS=false`**; **stale `dist`** (mitigated by **`clean-dist`**); **guild ID** not set (slower global propagation); wrong **guild** selected when testing.

---

## 7. Database and Migration Status

**db identity:** Operator runs **`npm run db:identity`** against the target `DATABASE_URL`.  
**Migrations:** Operator runs **`npm run db:migrate`** before relying on new columns.  
**Live table verification:** **`npm run db:verify-mint`** (checks Prisma table names + **`NonceLock_active_nonce_unique`** partial index).

| DB Object | Present (schema) | Notes |
|-----------|------------------|--------|
| `MintWallet` | Yes | |
| `MintWalletAuthorization` | Yes | |
| `CopyMintConfig` | Yes | |
| `MintJob` | Yes | |
| `MintDrop` | Yes | |
| `NonceLock` | Yes | expect **`NonceLock_active_nonce_unique`** |
| `MintTransaction` | Yes | |
| `MintSimulation` | Yes | |
| `MintAuditLog` | Yes | |
| `TrackedMintTrigger` | Yes | |
| `MintProviderHealth` | Yes | |
| `MintMainnetReadiness` | Yes | checklist JSON |
| `MainnetExecutionApproval` | Yes | |
| `MintEngineRuntimeState` | Yes | runtime emergency |

If migrations are not applied:

```bash
npm run db:migrate
npm run db:verify-mint
npm run db:identity
```

---

## 8. Mainnet Policy and Safety Gates

| Safety Gate | Enforced | Evidence | Risk |
|---------------|----------|----------|------|
| Mainnet blocked unless strict policy passes | Yes | `mainnetGuard`, `ExecutionPolicyEngine`, tests | Wrong env |
| `MINT_MAINNET_BETA` required | Yes | `mintEnv`, `mainnetBetaGates` tests | Beta off blocks controlled live |
| `MINT_MAINNET_BROADCAST_ENABLED` required | Yes | guard + env | |
| `MINT_TESTNET_ONLY` must be false for mainnet | Yes | policy tests | |
| Wallet approval required | Yes | `MainnetExecutionApproval` + HTTP/Discord flows | Mis-scoped approval |
| Signer approval required | Yes | `MINT_MAINNET_SIGNER_APPROVED` / local-dev variant | Unapproved signer |
| Gas cap required | Yes | `mintGasCapsConfigured` + policy | Missing caps → block |
| Max total cost required | Yes | same | |
| Max quantity required | Yes | job create tests | |
| One active job limit | Yes | env + policy | |
| Emergency stop | Yes | env + `MintEngineRuntimeState` + health | |
| Manual confirmation | Yes | env + confirm route | |
| Allowed collection restrictions | Yes | approval query tests | |
| No copy-mint live on mainnet | Yes | policy tests | |
| No private relay by default | Yes | env defaults + policy | |
| No auto-replace by default | Yes | env defaults + policy | |
| No `User.encryptedPrivateKey` use | Yes | `liveExecutionPolicy` string guard test | |
| No seed phrase / private key collection in Discord | Yes | command designs | phishing |

---

## 9. Signer Status

| Question | Answer |
|----------|--------|
| **Is signer configured?** | **Unknown in this document** — read **`Signer configured:`** on live **`/mint-status`**. |
| **What signer type is expected?** | See **`SignerAdapter.resolveMode()`** + `/status` field **`signerMode`** in engine; env **`MINT_REQUIRE_SECURE_SIGNER`**, local-dev flags in `mintEnv`. |
| **Is signer mainnet-approved?** | Check **`signerMainnetApproved`** on **`POST /v1/mint/status`** merge and env **`MINT_MAINNET_SIGNER_APPROVED`** (or local-dev approval). |
| **Avoid Discord private key input?** | Product intent: no collector commands; keys belong in **engine** secure config only. |
| **Avoid `User.encryptedPrivateKey`?** | **Yes** — automated test ensures engine module does not reference it. |
| **Verify `planHash`?** | **Yes** — `SignerAdapter` enforces **`planHash === approvedPlanHash`** on sign path. |
| **Respect gas/value caps?** | Policy + `GasEngine` / caps env — enforced before live path. |
| **Require nonce lock?** | Nonce lock model + execution flow — see engine/worker code. |
| **Block when emergency stop active?** | **Yes** — runtime + env OR semantics; signer/broadcast tests cover refusal. |

### If signer is not configured

**Current blocker:**  
Signer is not configured. Mainnet proof cannot proceed until signer is configured and approved.

**Next signer setup steps (no secrets in chat)**

1. Provision the **approved** signer backend for mint-engine (KMS/HSM or policy-allowed path).  
2. Set mint-engine env vars in **Railway** only (never Discord).  
3. Set **`MINT_MAINNET_SIGNER_APPROVED`** (or documented local-dev approval) **only** when runbook allows.  
4. **Redeploy / restart** mint-engine.  
5. Re-run **`/mint-status`** — confirm **`Signer configured: true`** and read the new **First blocker**.

---

## 10. Execution Flow Readiness

Flow (as requested; step 3 uses **current** slash name):

1. `/mint-status`  
2. Signer configured  
3. **`/mint-approve`** *(replaces legacy **`/mint-approve-wallet`**)*  
4. Dry-run  
5. Manual confirmation  
6. 0 ETH self-transfer  
7. `/mint-result`  
8. Emergency stop test  
9. Document proof  

| Step | Status | Blocker | Next action |
|------|--------|---------|-------------|
| 1. `/mint-status` | Ready (tooling) | — | Run in Discord; archive output |
| 2. Signer configured | **Not verified here** | signer | Follow §9 |
| 3. `/mint-approve` | **Not verified here** | admin + policy | Strict caps; one wallet |
| 4. Dry-run | **Not verified here** | RPC + flags | Engine job flow per runbook |
| 5. Manual confirmation | **Gated** | job state | `/mint-confirm-mainnet` when applicable |
| 6. 0 ETH self-transfer | **Not verified** | ops choice | If in runbook |
| 7. `/mint-result` | Tooling ready | real `job_id` | After job |
| 8. Emergency stop test | Tooling ready | ops | `/mint-emergency-stop` then resume |
| 9. Document proof | Not done | — | Internal doc |

---

## 11. What Has Been Covered

- Separate **Supermint** Discord app + **`mint-executor-bot`** process.  
- **Mint-engine** HTTP + **HMAC** + **health schema v2** + runtime DB flag in health.  
- **`/mint-status`** correctness (values + readiness + blockers).  
- **14** slash commands + **loader logging** + **legacy `*-wallet` dist skip** + **`clean-dist`** in build.  
- **Guild-first** registration when `MINT_EXECUTOR_GUILD_ID` set; optional **`MINT_EXECUTOR_REGISTER_GLOBAL_COMMANDS`**.  
- **Mainnet beta / broadcast / testnet / emergency / caps / quantity / jobs / manual confirm** in code + tests.  
- **`MainnetExecutionApproval`** + Discord **approve / revoke / list**.  
- **Prisma models** + **`db:verify-mint`** index check script.  

---

## 12. What Is Not Yet Proven

- Production **signer** live signing.  
- **Wallet approval** via Discord end-to-end on prod DB.  
- **Mainnet dry-run** completion in prod.  
- **0 ETH self-transfer** (if required by runbook).  
- **`MintTransaction`** from a **real** mainnet hash in prod.  
- **`/mint-result`** after a real broadcast.  
- **Emergency stop** under prod load.  
- **Low-cost public mint** / FCFS — **explicitly not** first proof target.  

---

## 13. Immediate Next Steps

1. **Configure approved signer** — mint-engine Railway env + deploy (**no keys in Discord**).  
2. **`/mint-status`** — confirm **`Signer configured: true`**.  
3. **`/mint-status`** — confirm **Mainnet proof readiness** advances; note **First blocker**.  
4. **`/mint-approve`** — one wallet; strict **`max_fee_per_gas`**, **`max_priority_fee_per_gas`**, **`max_total_cost_native`**, optional **`max_quantity`**, **`expires_in_hours`**, **`allowed_collections`**.  
5. **Mainnet dry-run** — engine job path per **`docs/mainnet-beta-runbook.md`** / internal runbook.  
6. **`/mint-confirm-mainnet`** — when manual confirmation is required.  
7. **0 ETH self-transfer** — if still a proof step.  
8. **`/mint-result`** — paste **`job_id`**.  
9. **`/mint-emergency-stop`** / **`/mint-emergency-resume`** — controlled drill.  
10. **Document proof** — job ids, tx hashes, timestamps, approvers (no secrets).  

---

## 14. Do Not Do Yet

- Do **not** run an **NFT mint** as the first mainnet proof.  
- Do **not** enable **`MINT_MAINNET_COPY_LIVE_ENABLED`** for proof.  
- Do **not** enable **`MINT_MAINNET_PRIVATE_RELAY_ENABLED`**.  
- Do **not** approve **multiple** wallets outside beta policy.  
- Do **not** raise **gas / cost caps** to bypass failures.  
- Do **not** disable **emergency stop** or **manual confirmation**.  
- Do **not** open execution to **end users** before runbook sign-off.  
- Do **not** target **FCFS / hyped** mints for first proof.  

---

## 15. Final Readiness Verdict

**Status fixed; commands restored; signer configuration next**

The **software path** for health, status, slash registration, and **policy gates** is in place on **`master`** (latest: **`d98e841`** for this doc). **Railway** last showed mint-engine / mint-executor on app commit **`9be8350`** — re-check after pulling **`d98e841`** (doc-only) or any newer code deploy. **Operational mainnet proof** still depends on **live signer**, **DB migration verification**, **approvals**, and **exercise** of dry-run / tx flows — which only the operator can complete safely.

---

## 16. Operator Checklist

- [ ] `/mint-status` shows no `undefined`  
- [ ] All mint commands visible (14) on **Supermint**  
- [ ] Signer configured (`Signer configured: true`)  
- [ ] One wallet approved via **`/mint-approve`** with strict caps  
- [ ] Dry-run passed (evidence logged)  
- [ ] 0 ETH self-transfer completed *(if in runbook)*  
- [ ] `/mint-result` verified for a real job  
- [ ] Emergency stop tested  
- [ ] Proof documented (no secrets)  

---

### Deliverable path

`docs/current-mint-bot-readiness-report.md`
