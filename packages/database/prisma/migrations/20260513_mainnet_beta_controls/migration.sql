-- Mainnet beta: runtime emergency flag + explicit mainnet execution approvals.

CREATE TABLE IF NOT EXISTS "MintEngineRuntimeState" (
    "id" TEXT NOT NULL,
    "emergencyStop" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadataJson" JSONB,
    CONSTRAINT "MintEngineRuntimeState_pkey" PRIMARY KEY ("id")
);

INSERT INTO "MintEngineRuntimeState" ("id", "emergencyStop", "createdAt", "updatedAt")
VALUES ('default', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "MainnetExecutionApproval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "mintWalletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 1,
    "approvedBy" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'active',
    "maxFeePerGas" TEXT,
    "maxPriorityFeePerGas" TEXT,
    "maxTotalCostNative" TEXT,
    "maxQuantity" INTEGER NOT NULL DEFAULT 1,
    "allowedCollections" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadataJson" JSONB,
    CONSTRAINT "MainnetExecutionApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MainnetExecutionApproval_lookup_idx" ON "MainnetExecutionApproval"("guildId", "userId", "mintWalletId", "approvalStatus");
CREATE INDEX IF NOT EXISTS "MainnetExecutionApproval_expiresAt_idx" ON "MainnetExecutionApproval"("expiresAt");

ALTER TABLE "MainnetExecutionApproval" DROP CONSTRAINT IF EXISTS "MainnetExecutionApproval_guildId_fkey";
ALTER TABLE "MainnetExecutionApproval" ADD CONSTRAINT "MainnetExecutionApproval_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MainnetExecutionApproval" DROP CONSTRAINT IF EXISTS "MainnetExecutionApproval_userId_fkey";
ALTER TABLE "MainnetExecutionApproval" ADD CONSTRAINT "MainnetExecutionApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MainnetExecutionApproval" DROP CONSTRAINT IF EXISTS "MainnetExecutionApproval_mintWalletId_fkey";
ALTER TABLE "MainnetExecutionApproval" ADD CONSTRAINT "MainnetExecutionApproval_mintWalletId_fkey" FOREIGN KEY ("mintWalletId") REFERENCES "MintWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
