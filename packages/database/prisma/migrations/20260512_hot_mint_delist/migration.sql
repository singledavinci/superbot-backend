-- Hot mint routing + optional delist routing per tracked collection.

ALTER TABLE "TrackedCollection" ADD COLUMN IF NOT EXISTS "hotMintEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TrackedCollection" ADD COLUMN IF NOT EXISTS "hotMintChannelId" TEXT;
ALTER TABLE "TrackedCollection" ADD COLUMN IF NOT EXISTS "delistAlertEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TrackedCollection" ADD COLUMN IF NOT EXISTS "delistChannelId" TEXT;
