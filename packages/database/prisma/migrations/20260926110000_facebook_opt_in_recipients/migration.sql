CREATE TABLE "FacebookOptInRecipient" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "groupUrl" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "consentSource" TEXT NOT NULL,
    "consentNote" TEXT,
    "consentRecordedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastMessageAttemptAt" TIMESTAMP(3),
    "lastMessagedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookOptInRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FacebookOptInRecipient_organizationId_groupUrl_profileUrl_key"
ON "FacebookOptInRecipient"("organizationId", "groupUrl", "profileUrl");

CREATE INDEX "FacebookOptInRecipient_organizationId_groupUrl_revokedAt_idx"
ON "FacebookOptInRecipient"("organizationId", "groupUrl", "revokedAt");

CREATE INDEX "FacebookOptInRecipient_organizationId_profileUrl_idx"
ON "FacebookOptInRecipient"("organizationId", "profileUrl");

ALTER TABLE "FacebookOptInRecipient"
ADD CONSTRAINT "FacebookOptInRecipient_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
