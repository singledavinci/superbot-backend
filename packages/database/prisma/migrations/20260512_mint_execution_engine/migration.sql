-- Mint Execution Engine tables (additive).

CREATE TABLE IF NOT EXISTS "MintWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "signerType" TEXT NOT NULL,
    "signerReference" TEXT,
    "isExecutionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxFeePerGas" TEXT,
    "maxPriorityFeePerGas" TEXT,
    "maxTotalCostNative" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MintWallet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MintWallet_userId_chainId_idx" ON "MintWallet"("userId", "chainId");
CREATE INDEX IF NOT EXISTS "MintWallet_address_chainId_idx" ON "MintWallet"("address", "chainId");

ALTER TABLE "MintWallet" DROP CONSTRAINT IF EXISTS "MintWallet_userId_fkey";
ALTER TABLE "MintWallet" ADD CONSTRAINT "MintWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MintWalletAuthorization" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mintWalletId" TEXT NOT NULL,
    "grantedBy" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "MintWalletAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MintWalletAuthorization_guildId_userId_mintWalletId_idx" ON "MintWalletAuthorization"("guildId", "userId", "mintWalletId");

ALTER TABLE "MintWalletAuthorization" DROP CONSTRAINT IF EXISTS "MintWalletAuthorization_guildId_fkey";
ALTER TABLE "MintWalletAuthorization" ADD CONSTRAINT "MintWalletAuthorization_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MintWalletAuthorization" DROP CONSTRAINT IF EXISTS "MintWalletAuthorization_userId_fkey";
ALTER TABLE "MintWalletAuthorization" ADD CONSTRAINT "MintWalletAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MintWalletAuthorization" DROP CONSTRAINT IF EXISTS "MintWalletAuthorization_mintWalletId_fkey";
ALTER TABLE "MintWalletAuthorization" ADD CONSTRAINT "MintWalletAuthorization_mintWalletId_fkey" FOREIGN KEY ("mintWalletId") REFERENCES "MintWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "CopyMintConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackedWalletAddress" TEXT NOT NULL,
    "targetCollectionAddress" TEXT,
    "mode" TEXT NOT NULL,
    "executionWalletId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "maxFeePerGas" TEXT,
    "maxPriorityFeePerGas" TEXT,
    "maxTotalCostNative" TEXT,
    "executionModeDefault" TEXT NOT NULL DEFAULT 'simulation',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CopyMintConfig_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CopyMintConfig_guildId_userId_idx" ON "CopyMintConfig"("guildId", "userId");

ALTER TABLE "CopyMintConfig" DROP CONSTRAINT IF EXISTS "CopyMintConfig_guildId_fkey";
ALTER TABLE "CopyMintConfig" ADD CONSTRAINT "CopyMintConfig_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CopyMintConfig" DROP CONSTRAINT IF EXISTS "CopyMintConfig_userId_fkey";
ALTER TABLE "CopyMintConfig" ADD CONSTRAINT "CopyMintConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CopyMintConfig" DROP CONSTRAINT IF EXISTS "CopyMintConfig_executionWalletId_fkey";
ALTER TABLE "CopyMintConfig" ADD CONSTRAINT "CopyMintConfig_executionWalletId_fkey" FOREIGN KEY ("executionWalletId") REFERENCES "MintWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MintJob" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "collectionAddress" TEXT NOT NULL,
    "mintContract" TEXT NOT NULL,
    "dropSource" TEXT NOT NULL,
    "dropType" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "executionMode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "scheduledAt" TIMESTAMP(3),
    "startTime" TIMESTAMP(3),
    "maxFeePerGas" TEXT,
    "maxPriorityFeePerGas" TEXT,
    "maxTotalCostNative" TEXT,
    "txHash" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "planHash" TEXT,
    "simulationStatus" TEXT,
    "executionStartedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MintJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MintJob_guildId_status_scheduledAt_idx" ON "MintJob"("guildId", "status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "MintJob_planHash_idx" ON "MintJob"("planHash");
CREATE INDEX IF NOT EXISTS "MintJob_userId_idx" ON "MintJob"("userId");

ALTER TABLE "MintJob" DROP CONSTRAINT IF EXISTS "MintJob_guildId_fkey";
ALTER TABLE "MintJob" ADD CONSTRAINT "MintJob_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MintJob" DROP CONSTRAINT IF EXISTS "MintJob_userId_fkey";
ALTER TABLE "MintJob" ADD CONSTRAINT "MintJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MintJob" DROP CONSTRAINT IF EXISTS "MintJob_walletId_fkey";
ALTER TABLE "MintJob" ADD CONSTRAINT "MintJob_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "MintWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MintDrop" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "collectionAddress" TEXT NOT NULL,
    "mintContract" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dropType" TEXT NOT NULL,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "priceNative" TEXT,
    "maxPerWallet" INTEGER,
    "maxSupply" INTEGER,
    "stageId" TEXT,
    "merkleRoot" TEXT,
    "requiresProof" BOOLEAN NOT NULL DEFAULT false,
    "requiresSignature" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "resolvedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MintDrop_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MintDrop_chainId_mintContract_idx" ON "MintDrop"("chainId", "mintContract");

CREATE TABLE IF NOT EXISTS "NonceLock" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mintJobId" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    CONSTRAINT "NonceLock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "NonceLock_chainId_walletAddress_idx" ON "NonceLock"("chainId", "walletAddress");
CREATE INDEX IF NOT EXISTS "NonceLock_mintJobId_idx" ON "NonceLock"("mintJobId");

ALTER TABLE "NonceLock" DROP CONSTRAINT IF EXISTS "NonceLock_mintJobId_fkey";
ALTER TABLE "NonceLock" ADD CONSTRAINT "NonceLock_mintJobId_fkey" FOREIGN KEY ("mintJobId") REFERENCES "MintJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "NonceLock_active_nonce_unique";
CREATE UNIQUE INDEX "NonceLock_active_nonce_unique"
ON "NonceLock" ("chainId", LOWER("walletAddress"), "nonce")
WHERE "status" IN ('locked', 'submitted', 'replacing', 'conflict');

CREATE TABLE IF NOT EXISTS "MintTransaction" (
    "id" TEXT NOT NULL,
    "mintJobId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "calldataHash" TEXT NOT NULL,
    "txHash" TEXT,
    "status" TEXT NOT NULL,
    "providerResponsesJson" JSONB,
    "gasStrategyJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    CONSTRAINT "MintTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MintTransaction_mintJobId_idx" ON "MintTransaction"("mintJobId");
CREATE INDEX IF NOT EXISTS "MintTransaction_txHash_idx" ON "MintTransaction"("txHash");

ALTER TABLE "MintTransaction" DROP CONSTRAINT IF EXISTS "MintTransaction_mintJobId_fkey";
ALTER TABLE "MintTransaction" ADD CONSTRAINT "MintTransaction_mintJobId_fkey" FOREIGN KEY ("mintJobId") REFERENCES "MintJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MintSimulation" (
    "id" TEXT NOT NULL,
    "mintJobId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" TEXT,
    "gasEstimate" TEXT,
    "revertReason" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadataJson" JSONB,
    CONSTRAINT "MintSimulation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MintSimulation_mintJobId_idx" ON "MintSimulation"("mintJobId");

ALTER TABLE "MintSimulation" DROP CONSTRAINT IF EXISTS "MintSimulation_mintJobId_fkey";
ALTER TABLE "MintSimulation" ADD CONSTRAINT "MintSimulation_mintJobId_fkey" FOREIGN KEY ("mintJobId") REFERENCES "MintJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MintAuditLog" (
    "id" TEXT NOT NULL,
    "mintJobId" TEXT,
    "guildId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT,
    "message" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MintAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MintAuditLog_mintJobId_idx" ON "MintAuditLog"("mintJobId");
CREATE INDEX IF NOT EXISTS "MintAuditLog_guildId_createdAt_idx" ON "MintAuditLog"("guildId", "createdAt");

ALTER TABLE "MintAuditLog" DROP CONSTRAINT IF EXISTS "MintAuditLog_mintJobId_fkey";
ALTER TABLE "MintAuditLog" ADD CONSTRAINT "MintAuditLog_mintJobId_fkey" FOREIGN KEY ("mintJobId") REFERENCES "MintJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "TrackedMintTrigger" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "trackedWallet" TEXT NOT NULL,
    "collectionAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "triggerSource" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedForMint" BOOLEAN NOT NULL DEFAULT false,
    "metadataJson" JSONB,
    CONSTRAINT "TrackedMintTrigger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TrackedMintTrigger_trackedWallet_chainId_idx" ON "TrackedMintTrigger"("trackedWallet", "chainId");
CREATE INDEX IF NOT EXISTS "TrackedMintTrigger_txHash_idx" ON "TrackedMintTrigger"("txHash");

CREATE TABLE IF NOT EXISTS "MintProviderHealth" (
    "id" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MintProviderHealth_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MintProviderHealth_providerName_chainId_key" ON "MintProviderHealth"("providerName", "chainId");

CREATE TABLE IF NOT EXISTS "MintMainnetReadiness" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "checklistJson" JSONB NOT NULL DEFAULT '{}',
    "testnetVerifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MintMainnetReadiness_pkey" PRIMARY KEY ("id")
);

INSERT INTO "MintMainnetReadiness" ("id", "checklistJson", "updatedAt")
VALUES ('default', '{}', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
