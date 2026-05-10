-- AlertDeliveryLog: per-route idempotent delivery records for outbound Discord alerts.
CREATE TABLE IF NOT EXISTS "AlertDeliveryLog" (
    "id"          TEXT PRIMARY KEY,
    "deliveryKey" TEXT NOT NULL UNIQUE,
    "eventId"     TEXT NOT NULL,
    "channelId"   TEXT NOT NULL,
    "alertType"   TEXT NOT NULL,
    "status"      TEXT NOT NULL,
    "error"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AlertDeliveryLog_eventId_idx"   ON "AlertDeliveryLog"("eventId");
CREATE INDEX IF NOT EXISTS "AlertDeliveryLog_createdAt_idx" ON "AlertDeliveryLog"("createdAt");
