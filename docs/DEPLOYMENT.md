## Deployment plan (Railway + Docker)

### Railway (recommended)
- Create a Railway project with services:
  - `superbot-backend` (API + optionally worker/indexer as separate services)
  - `superbot-dashboard`
  - Postgres + Redis + ClickHouse
- Configure env vars per service:
  - Discord: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
  - JWT: `JWT_SECRET`
  - DB: `DATABASE_URL`
  - Redis: `REDIS_URL`
  - Providers: `RESERVOIR_API_KEY`, `ALCHEMY_KEY` (etc.)
- Use separate services for indexer/worker with distinct `SERVICE_TYPE`.

### Docker (local/prod)
- `docker-compose.prod.yml` provides a baseline for running services together.
- Use `.env` for local only; do not commit real secrets.

### Release hygiene
- Run `npm run build` for backend and `npm run build && npm run lint` for dashboard in CI.
- Add migrations workflow: `prisma migrate deploy`.

### Pending migrations
- `packages/database/prisma/migrations/20260510_add_alert_delivery_log/migration.sql`
  - Adds `AlertDeliveryLog` table for idempotent Discord delivery + observability.
  - Apply via `psql` against Railway Postgres, or wire the standard Prisma migrations workflow:
    1. From a clean checkout: `npx prisma migrate dev --name add_alert_delivery_log` against a dev DB.
    2. In Railway production: `npx prisma migrate deploy`.

