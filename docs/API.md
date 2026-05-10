## API Routes (current + MVP target)

### Public/health
- `GET /api/health`
  - Returns `{ status: "ok", service: "superbot-api" }`

### Auth (Discord OAuth)
- `GET /api/v1/auth/discord`
- `GET /api/v1/auth/discord/callback`
- `GET /api/v1/auth/me`
  - **Auth**: `Authorization: Bearer <jwt>`
  - Returns `{ guildId, id, username }`

### Guild configuration (Dashboard)
- `GET /api/v1/guilds/:id/rules`
  - Returns unified rules list used by dashboard
- `GET /api/v1/guilds/:id/status`
  - Returns `{ plan, channels, wallets, collections }`
- `GET /api/v1/guilds/:id/wallets`
- `POST /api/v1/guilds/:id/wallets`
- `DELETE /api/v1/guilds/:id/wallets/:walletId`
- `GET /api/v1/guilds/:id/collections`
- `POST /api/v1/guilds/:id/collections`
- `DELETE /api/v1/guilds/:id/collections/:collectionId`

### MVP additions (planned)
- `GET /api/v1/guilds/:id/deliveries?status=failed&since=...`
- `GET /api/v1/wallets/:address/summary`
- `GET /api/v1/collections/:contract/summary`

