## Testing plan

### MVP test layers
- **Unit tests**
  - idempotency key generation
  - routing logic (event → routes)
  - embed formatting (snapshot tests)
- **Integration tests**
  - API endpoints against a local Postgres
  - queue + delivery worker with Discord mocked
- **End-to-end smoke**
  - start services (api/bot/indexer/worker)
  - run a synthetic event through pipeline
  - verify exactly-one Discord delivery and a logged delivery record

### Runtime assertions (production)
- Alert de-duplication invariants:
  - no more than 1 delivery per `(eventId, routeId)`
- Lag monitor:
  - indexed head within threshold of chain head

