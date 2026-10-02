CREATE TABLE "FacebookMessageRecipient" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "groupUrl" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "displayName" TEXT,
    "taskId" UUID,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookMessageRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FacebookMessageRecipient_organizationId_groupUrl_profileUrl_key"
ON "FacebookMessageRecipient"("organizationId", "groupUrl", "profileUrl");

CREATE INDEX "FacebookMessageRecipient_organizationId_groupUrl_status_idx"
ON "FacebookMessageRecipient"("organizationId", "groupUrl", "status");

CREATE INDEX "FacebookMessageRecipient_organizationId_profileUrl_idx"
ON "FacebookMessageRecipient"("organizationId", "profileUrl");

ALTER TABLE "FacebookMessageRecipient"
ADD CONSTRAINT "FacebookMessageRecipient_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
