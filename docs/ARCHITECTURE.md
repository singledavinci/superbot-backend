## Technical Architecture (MVP → V1)

### Services (MVP)
- **Discord Bot** (`apps/bot`): slash commands, embeds, interactivity; publishes config + queries API.
- **Admin API** (`apps/api`): Discord OAuth, guild configuration, CRUD for rules/watchlists.
- **Indexer** (`apps/indexer`): consumes chain/provider streams; writes normalized events; emits jobs.
- **Worker** (`apps/worker`): enrichment + alert routing + delivery queue jobs.
- **Dashboard** (`superbot-dashboard` repo): admin UI.

### Data stores
- **Postgres**: guilds, users, rules, watchlists, delivery logs, idempotency keys.
- **Redis**: queues (BullMQ), rate-limit state, dedupe short-term cache, checkpoints (optional).
- **ClickHouse** (optional for MVP, recommended early): high-volume events + analytics aggregates.

### Provider strategy (MVP)
- **Primary**: Reservoir for NFT sales/listings/floor (normalized marketplace data).
- **Fallback**: raw on-chain via Alchemy/QuickNode/Infura websockets for transfers/mints.

### Event pipeline (high level)
1. Indexer consumes provider stream(s) → emits `NormalizedNftEvent`.
2. Indexer writes event to durable store (Postgres table or ClickHouse) with **idempotency key**.
3. Worker enriches (labels, pricing, collection metadata cache) and computes routing targets.
4. Worker enqueues `discord_alert` jobs to BullMQ with deterministic job IDs.
5. Delivery worker sends to Discord and records `AlertDeliveryLog`.

### Duplicate prevention (must)
- **Event idempotency**: unique constraint on `(chain, provider, providerEventId)` or `eventHash`.
- **Delivery idempotency**: unique constraint on `(eventId, routeId)` plus BullMQ job IDs.

### Reorg handling (MVP)
- Indexer emits events as `pending` until confirmations depth.
- On reorg, mark events `reorged`; downstream delivery either:
  - do not send (if still pending), or
  - send “reorged/invalidated” follow-up if already sent (V1).

### Scaling plan (MVP-ready)
- Partition indexing per chain + shard by contract buckets.
- Horizontal scale worker consumers by queue.
- Use bulk insert to ClickHouse for event throughput.
- Cache collection metadata (image/name) in Redis + object storage (V1).

