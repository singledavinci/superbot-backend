## Event pipeline design (MVP)

### Normalized event
All providers must map to a single internal shape before routing.

Required fields:
- `eventId` (stable, idempotency key)
- `chain`
- `eventType` (sale|listing|mint|transfer|floor)
- `contract`
- `tokenId?`
- `txHash?`
- `timestamp`
- `buyer? seller? from? to?`
- `price? currency?`
- `marketplace?`
- `raw` (provider payload for debugging)

### Steps
1. **Ingest**
   - Reservoir stream for sales/listings/floor (recommended)
   - On-chain WS for transfers/mints (fallback)
2. **Persist**
   - Insert into ClickHouse (append-only) and/or Postgres (idempotent table)
3. **Route**
   - Resolve which guilds care (tracked wallets/collections + alert channel rules)
4. **Enrich**
   - Metadata cache (collection name, image)
   - Wallet labels (ENS / curated labels)
5. **Deliver**
   - BullMQ job per `(eventId, routeId)`
   - Record delivery result and retry state

### Idempotency keys
- Provider event ids should be used when available.
- Otherwise compute: `sha256(chain|type|contract|tokenId|txHash|logIndex|timestampBucket)`

### Backpressure
- Queue consumer concurrency capped
- Drop/merge repeated floor updates within a small time window (MVP optimization)

