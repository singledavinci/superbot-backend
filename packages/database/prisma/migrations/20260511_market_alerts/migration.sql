-- Optional thresholds for sweep / mass listing / floor pump alerts on tracked collections.
-- Idempotent for production re-application.

ALTER TABLE "TrackedCollection" ADD COLUMN IF NOT EXISTS "floorRiseAlertPct" DOUBLE PRECISION;
ALTER TABLE "TrackedCollection" ADD COLUMN IF NOT EXISTS "sweepThresholdNative" DOUBLE PRECISION;
ALTER TABLE "TrackedCollection" ADD COLUMN IF NOT EXISTS "massListingThreshold" INTEGER;
