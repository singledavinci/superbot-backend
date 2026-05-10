-- Repairs schema drift: tables that were created by an earlier `prisma db push`
-- before the project moved to versioned SQL migrations were missing columns
-- that the current Prisma client expects. `CREATE TABLE IF NOT EXISTS` in
-- the prior migrations was a no-op for those tables, so the columns were
-- never added. This migration uses `ADD COLUMN IF NOT EXISTS` so it is safe
-- to re-run.

-- User --------------------------------------------------------------------
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "encryptedPrivateKey" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "autoMintEnabled"     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "maxMintPrice"        DOUBLE PRECISION NOT NULL DEFAULT 0.1;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gasBufferGwei"       DOUBLE PRECISION NOT NULL DEFAULT 5.0;

-- AlertChannel ------------------------------------------------------------
ALTER TABLE "AlertChannel" ADD COLUMN IF NOT EXISTS "mentionRoleId" TEXT;

-- TrackedWallet -----------------------------------------------------------
ALTER TABLE "TrackedWallet" ADD COLUMN IF NOT EXISTS "mentionRoleId" TEXT;

-- TrackedCollection -------------------------------------------------------
ALTER TABLE "TrackedCollection" ADD COLUMN IF NOT EXISTS "mentionRoleId" TEXT;
