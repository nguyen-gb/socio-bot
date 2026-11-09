CREATE TABLE "FacebookActionTarget" (
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

    CONSTRAINT "FacebookActionTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FacebookActionTarget_organizationId_accountId_action_targetKey_key"
ON "FacebookActionTarget"("organizationId", "accountId", "action", "targetKey");

CREATE INDEX "FacebookActionTarget_organizationId_accountId_action_status_idx"
ON "FacebookActionTarget"("organizationId", "accountId", "action", "status");

CREATE INDEX "FacebookActionTarget_taskId_status_idx"
ON "FacebookActionTarget"("taskId", "status");

ALTER TABLE "FacebookActionTarget"
ADD CONSTRAINT "FacebookActionTarget_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
