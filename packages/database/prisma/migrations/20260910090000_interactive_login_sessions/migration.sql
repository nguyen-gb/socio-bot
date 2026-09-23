-- Extend the browser session lifecycle for interactive login.
ALTER TYPE "BrowserSessionStatus" ADD VALUE IF NOT EXISTS 'AUTHENTICATED';
ALTER TYPE "BrowserSessionStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

CREATE TYPE "BrowserSessionMode" AS ENUM ('LOGIN', 'AUTOMATION');

ALTER TABLE "BrowserSession"
  ALTER COLUMN "workerId" DROP NOT NULL,
  ALTER COLUMN "slotId" DROP NOT NULL,
  ADD COLUMN "workflowId" TEXT,
  ADD COLUMN "mode" "BrowserSessionMode" NOT NULL DEFAULT 'LOGIN',
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT;

UPDATE "BrowserSession"
SET "expiresAt" = "startedAt" + INTERVAL '30 minutes'
WHERE "expiresAt" IS NULL;

ALTER TABLE "BrowserSession"
  ALTER COLUMN "expiresAt" SET NOT NULL;

CREATE UNIQUE INDEX "BrowserSession_workflowId_key"
  ON "BrowserSession"("workflowId");

CREATE UNIQUE INDEX "BrowserSession_one_active_profile_idx"
  ON "BrowserSession"("profileId")
  WHERE "status" IN ('STARTING', 'RUNNING', 'CLOSING');
