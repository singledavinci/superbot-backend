## Security plan (MVP)

### Secrets
- Store all secrets in Railway/environment variables (no secrets in git).
- Rotate Discord bot token and provider keys regularly.

### Data boundaries
- All guild resources are tenant-scoped.
- API endpoints must validate that the caller’s Discord identity is authorized for the guild.

### Discord policies
- Respect rate limits; do not scrape user data.
- Never request seed phrases or private keys.

### Web security
- Helmet + CORS (allow dashboard origin only).
- JWT signing secret must be long, rotated, and not fall back to defaults in production.

### Wallet “sniping” key storage (current code warning)
- Current code stores a private key in DB with reversible encoding.
- **MVP recommendation**: disable this feature or implement envelope encryption (KMS/Vault) before production use.

