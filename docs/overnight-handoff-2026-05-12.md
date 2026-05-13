# Overnight handoff (2026-05-12)

This file captures what was completed automatically and what still requires operator action.

## Completed in code

- Mainnet beta controls are wired in mint engine and executor bot:
  - `MainnetExecutionApproval` and runtime emergency state paths are integrated.
  - Mainnet strict gates (`evaluateMainnetStrict`) are active for live and dry-run phases.
  - `mainnet_dry_run` mode runs real resolver/simulation/nonce-lock flow and never signs/broadcasts.
  - Runtime emergency endpoints exist: `/v1/mint/runtime/emergency-stop` and `/v1/mint/runtime/emergency-resume`.
  - Mainnet live explicit operator confirmation endpoint exists: `/v1/mint/jobs/confirm-mainnet`.
  - Executor admin commands exist: `/mint-emergency-stop` and `/mint-emergency-resume`.
- Regression test coverage added for gate ordering:
  - `apps/mint-engine/src/__tests__/mainnetBetaGates.test.ts` now asserts `MAINNET_RPC_REQUIRED` when `MINT_MAINNET_RPC_URL` is absent.
- Additional automated coverage (no operator secrets required):
  - `mainnetApprovalQueries.test.ts`, `emergencyRuntime.test.ts`, `mainnetSingleFlight.test.ts`, `mainnetDryRunCreateJob.test.ts`, `mainnetLiveCreateJob.test.ts`, `mintRoutesConfirmMainnet.test.ts` (confirm + emergency routes; queue handles closed in teardown).

## Validation status

- `npm test`: PASS (112 tests, 0 failures)
- `npm run build`: PASS
- Lint diagnostics on touched test files: no issues

## Still manual (operator required)

- Fill `docs/testnet-live-execution-proof.md` with real evidence:
  - real testnet tx hash
  - `MintJob` / `MintTransaction` IDs and final states
  - Discord proof
- Execute and verify one controlled `mainnet_dry_run` on chain `1`.
- Fill `docs/mainnet-beta-proof.md` after first controlled mainnet beta transaction (or explicitly mark dry-run only).
- Decide PAUSE or CONTINUE after first beta proof.

## Suggested morning checklist

1. Confirm environment values for beta safety:
   - `MINT_TESTNET_ONLY=false` only when intentionally starting beta window
   - `MINT_MAINNET_BROADCAST_ENABLED=true` only during approved beta window
   - `MINT_MAINNET_DRY_RUN=true` for dry-run verification
   - `MINT_MAINNET_BETA_*` values set to one approved guild/user/wallet
2. Ensure active `MainnetExecutionApproval` row exists and allow-list is correct.
3. Run a `mainnet_dry_run` job, verify it ends as `mainnet_dry_run_complete`.
4. For a live mainnet job, call `/v1/mint/jobs/confirm-mainnet` before execution.
5. Keep emergency controls ready:
   - `/mint-emergency-stop` in Discord
   - `/v1/mint/runtime/emergency-stop` via API

