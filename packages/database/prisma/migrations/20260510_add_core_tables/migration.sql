-- Adds core tables that are referenced in code but were never created in the
-- production database. Idempotent: safe to re-run.

-- SyncState tracks the last indexed block per chain.
CREATE TABLE IF NOT EXISTS "SyncState" (
    "chain"     TEXT PRIMARY KEY,
    "lastBlock" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- User holds Discord-linked accounts and per-user sniper config.
CREATE TABLE IF NOT EXISTS "User" (
    "id"                  TEXT PRIMARY KEY,
    "discordId"           TEXT NOT NULL,
    "walletAddress"       TEXT,
    "encryptedPrivateKey" TEXT,
    "autoMintEnabled"     BOOLEAN NOT NULL DEFAULT FALSE,
    "maxMintPrice"        DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "gasBufferGwei"       DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "globalPremiumStatus" BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_discordId_key" ON "User" ("discordId");

-- AlertChannel routes alerts to a Discord channel within a guild.
CREATE TABLE IF NOT EXISTS "AlertChannel" (
    "id"               TEXT PRIMARY KEY,
    "guildId"          TEXT NOT NULL,
    "discordChannelId" TEXT NOT NULL,
    "name"             TEXT NOT NULL,
    "alertType"        TEXT NOT NULL,
    "mentionRoleId"    TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "AlertChannel_discordChannelId_key" ON "AlertChannel" ("discordChannelId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'AlertChannel_guildId_fkey'
           AND table_name = 'AlertChannel'
    ) THEN
        ALTER TABLE "AlertChannel"
            ADD CONSTRAINT "AlertChannel_guildId_fkey"
            FOREIGN KEY ("guildId") REFERENCES "Guild"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- Watchlist allows a user to follow wallets/collections across guilds.
CREATE TABLE IF NOT EXISTS "Watchlist" (
    "id"            TEXT PRIMARY KEY,
    "userId"        TEXT NOT NULL,
    "targetType"    TEXT NOT NULL,
    "targetAddress" TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "Watchlist_userId_targetType_targetAddress_key"
    ON "Watchlist" ("userId", "targetType", "targetAddress");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'Watchlist_userId_fkey'
           AND table_name = 'Watchlist'
    ) THEN
        ALTER TABLE "Watchlist"
            ADD CONSTRAINT "Watchlist_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
