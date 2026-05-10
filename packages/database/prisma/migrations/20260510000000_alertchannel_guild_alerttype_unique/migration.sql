-- One routing row per (guild, alertType). Same Discord channel may back multiple types.
DELETE FROM "AlertChannel" AS a
    USING "AlertChannel" AS b
WHERE a.ctid < b.ctid
  AND a."guildId" = b."guildId"
  AND a."alertType" = b."alertType";

DROP INDEX IF EXISTS "AlertChannel_discordChannelId_key";

CREATE UNIQUE INDEX "AlertChannel_guildId_alertType_key" ON "AlertChannel"("guildId", "alertType");
