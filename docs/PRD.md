## PRD — Discord-native NFT Intelligence Platform

### Summary
Build a Discord bot + web admin dashboard that enables Discord guilds to monitor wallets and collections for NFT market activity and receive real-time alerts. Product is multi-tenant, scalable, rate-limit safe, and restart-safe.

### Target users
- **Guild admins**: configure watchlists, channels, role pings, and thresholds.
- **Analysts / traders**: consume alerts and query wallets/collections via slash commands.
- **Premium members** (V1+): access premium channels, advanced analytics, and higher quotas.

### Core problems solved
- Reduce time-to-awareness for meaningful on-chain + marketplace activity.
- Provide context so users avoid noisy/duplicated alerts and FOMO.
- Make configuration and alert routing Discord-native and guild-centric.

### MVP requirements (must ship)
#### Authentication & tenancy
- Login: Discord OAuth2 in dashboard.
- Tenant boundary: all data scoped to **guild**; per-guild rules and watchlists.

#### Tracking
- Track wallets: buy/sell/mint/transfer for specified wallets.
- Track collections: sales + listings + floor moves for specified collections (ETH mainnet).

#### Alerts
- Per-guild alert routes:
  - alert type → channel(s) + optional role ping
- Discord embeds:
  - type, collection name, token id, price, marketplace, tx link, timestamp, buyer/seller, wallet label (if known)
- Duplicate prevention:
  - idempotency key per event + per-route delivery log
- Rate limit compliance:
  - all outbound messages queued; retry with backoff

#### Reliability
- RPC/provider failover (primary + secondary)
- Reorg-safe indexing:
  - configurable confirmation depth
  - events emitted as pending → confirmed
- Restart safety:
  - persisted checkpoints per chain/provider stream

#### Observability
- Structured logs with correlation IDs (event id, guild id, chain).
- Lag metrics: head block vs indexed block.
- Alert delivery metrics: success/failure, retries, latency.

### Non-goals (MVP)
- Multi-chain beyond Ethereum
- AI summaries
- Billing, quotas enforcement UI
- Full smart-money / flip analytics

