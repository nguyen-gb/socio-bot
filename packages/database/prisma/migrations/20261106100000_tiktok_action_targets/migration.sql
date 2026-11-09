CREATE TABLE "TikTokActionTarget" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "taskId" UUID,
    "action" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TikTokActionTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokActionTarget_organizationId_accountId_action_targetKey_key"
ON "TikTokActionTarget"("organizationId", "accountId", "action", "targetKey");

CREATE INDEX "TikTokActionTarget_organizationId_accountId_action_status_idx"
ON "TikTokActionTarget"("organizationId", "accountId", "action", "status");

CREATE INDEX "TikTokActionTarget_taskId_status_idx"
ON "TikTokActionTarget"("taskId", "status");

ALTER TABLE "TikTokActionTarget"
ADD CONSTRAINT "TikTokActionTarget_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
