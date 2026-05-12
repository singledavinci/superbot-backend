-- MainnetExecutionApproval.approvedBy: explicit non-null default for audit trail
UPDATE "MainnetExecutionApproval" SET "approvedBy" = COALESCE("approvedBy", '');
ALTER TABLE "MainnetExecutionApproval" ALTER COLUMN "approvedBy" SET DEFAULT '';
ALTER TABLE "MainnetExecutionApproval" ALTER COLUMN "approvedBy" SET NOT NULL;
