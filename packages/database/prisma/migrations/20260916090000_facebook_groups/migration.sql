CREATE TABLE "FacebookGroupMembership" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "groupUrl" TEXT NOT NULL,
  "groupName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastPostAt" TIMESTAMP(3),
  CONSTRAINT "FacebookGroupMembership_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FacebookCampaign" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FacebookCampaign_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Task" ADD COLUMN "campaignId" UUID;
CREATE UNIQUE INDEX "FacebookGroupMembership_accountId_groupUrl_key" ON "FacebookGroupMembership"("accountId", "groupUrl");
CREATE INDEX "FacebookGroupMembership_organizationId_status_idx" ON "FacebookGroupMembership"("organizationId", "status");
CREATE UNIQUE INDEX "FacebookCampaign_organizationId_idempotencyKey_key" ON "FacebookCampaign"("organizationId", "idempotencyKey");
CREATE INDEX "FacebookCampaign_organizationId_createdAt_idx" ON "FacebookCampaign"("organizationId", "createdAt");
CREATE INDEX "Task_campaignId_status_idx" ON "Task"("campaignId", "status");
ALTER TABLE "FacebookGroupMembership" ADD CONSTRAINT "FacebookGroupMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FacebookGroupMembership" ADD CONSTRAINT "FacebookGroupMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FacebookCampaign" ADD CONSTRAINT "FacebookCampaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "FacebookCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
