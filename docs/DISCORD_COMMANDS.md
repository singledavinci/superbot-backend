## Discord command specification (MVP → V1)

### MVP commands
- `/setup`
  - **Purpose**: guided onboarding for a guild (select alert channels, create defaults).
  - **Permissions**: Manage Guild
- `/track-wallet address [channel] [events] [role]`
  - **Events**: buy, sell, mint, transfer
- `/track-collection contract-or-slug [channel] [events] [role]`
  - **Events**: sale, listing, floor-above, floor-below
- `/untrack type wallet|collection identifier`
- `/watchlist list`
  - shows tracked wallets/collections for guild

### V1+ commands (planned)
- `/wallet address` (wallet analytics)
- `/collection contract-or-slug` (collection analytics)
- `/smart-money timeframe chain`
- `/trending timeframe chain`
- `/mint-radar chain timeframe`
- `/leaderboard wallets metric timeframe`
- `/risk collection-or-contract`
- `/billing plan|usage`

### Embed templates (MVP)
All alerts should include at minimum:
- Alert type + chain
- Collection name + image (if available)
- Token ID (if applicable)
- Price + currency
- Marketplace link + transaction link
- Buyer/seller + labels (if known)
- Timestamp
- Footer disclaimer: “Not financial advice”

