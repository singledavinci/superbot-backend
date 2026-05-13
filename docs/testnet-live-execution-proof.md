# Testnet live execution — proof report

This document **freezes** evidence that the SuperBot Mint Execution Engine completed **Sepolia (or other testnet) live execution** before any controlled mainnet beta work.

**Operator:** fill all bracketed placeholders from Railway logs, Postgres, Etherscan Sepolia, and Discord. Append a dated section for each new proof run.

---

## Environment (at time of proof)

| Field | Value |
|--------|--------|
| Mint engine deployment / image digest | _(Railway → Deployments)_ |
| `MINT_DEFAULT_CHAIN_ID` | _(e.g. `11155111`)_ |
| `MINT_TESTNET_ONLY` | `true` |
| `MINT_MAINNET_BROADCAST_ENABLED` | `false` |
| `MINT_ENGINE_MODE` | `live` |
| `MINT_EXECUTION_ENABLED` | `true` |
| Signer mode | `local-dev-signer` / `external-signer` |
| `npm run build` / `npm test` | **PASS** _(commit SHA)_ |

---

## Execution proof (single controlled run)

| Field | Value |
|--------|--------|
| **Chain used** | _(e.g. Sepolia `11155111`)_ |
| **Wallet used** | `0x…` _(test wallet only)_ |
| **Transaction type** | _(e.g. SeaDrop `mintPublic` / self-transfer)_ |
| **tx hash** | `0x…` |
| **simulationStatus** | `PASS` |
| **Nonce lock** | Acquired → terminal state |
| **Gas policy** | `MINT_MAX_*` values used |
| **Broadcast provider** | _(RPC host; redact keys)_ |
| **Receipt status** | success / reverted |
| **MintJob.id** | |
| **MintJob.final status** | |
| **MintTransaction row** | **yes** |
| **Discord `/mint-result`** | **yes** / no |
| **Mainnet blocked during testnet** | **yes** — no chainId `1` broadcast |

---

## Audit and safety

- [ ] `MintAuditLog` includes job lifecycle events.
- [ ] No `User.encryptedPrivateKey` used.
- [ ] No secrets in Discord or public logs.

## Sign-off

| Role | Name | Date |
|------|------|------|
| Operator | | |
| Reviewer | | |
