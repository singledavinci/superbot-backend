## SuperBot NFT Intelligence Platform (Discord-native)

### Goal
Build a Discord-first NFT intelligence platform (bot + admin dashboard + indexing/analytics pipeline) that provides real-time, actionable NFT trading signals for Discord communities.

### MVP (ship-first) scope
The MVP is intentionally narrow so we can verify correctness, throughput, duplicate-prevention, and Discord delivery at production quality before adding chains/providers/features.

#### Supported chains
- Ethereum mainnet only (EVM foundation)

#### Supported event types (alerts)
- **Sales**: ERC-721/1155 transfers with value (marketplace fills) via a single primary provider (Reservoir recommended for NFT market-normalization).
- **Listings** (basic): best-ask changes for tracked collections (provider-dependent; Reservoir supports).
- **Mints** (basic): contract mint detection for tracked contracts (on-chain transfer from zero address + heuristics).
- **Transfers**: wallet movements for tracked wallets (non-sale transfers).

#### Core user actions
- Discord bot:
  - `/setup` (guild onboarding, choose channels)
  - `/track-wallet <address> [channel] [events] [role]`
  - `/track-collection <contract-or-slug> [channel] [events] [role]`
  - `/untrack ...`
  - `/watchlist list`
- Admin dashboard:
  - Discord OAuth login
  - select guild
  - manage tracked wallets/collections
  - configure alert routing (channels + role pings)

#### Non‑negotiables (MVP)
- No duplicate alerts (idempotency keys + delivery log)
- Queue-based Discord sends (rate-limit safe)
- Provider failover (primary + secondary)
- Restart-safe indexing (resume checkpoints)
- Basic observability: structured logs + lag metrics

### V1 expansion (after MVP proves stable)
- Smart-money scoring + flip winner ranking
- Floor change alerts + collection analytics pages
- Multi-chain (Base/Polygon/Arbitrum/Optimism)
- Premium channels + quotas + billing
- AI summaries + risk scoring

### “Remove demo data” policy (applies immediately)
- Dashboard must not show fabricated metrics (accuracy %, “live” chain load, etc.).
- UI may show:
  - **real counts** from DB (tracked wallets/collections/channels)
  - **real service health** from API
  - **explicit TODO** labels for not-yet-implemented real-time analytics.

