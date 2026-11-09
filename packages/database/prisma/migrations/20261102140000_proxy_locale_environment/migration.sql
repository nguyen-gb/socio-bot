ALTER TABLE "Proxy"
ADD COLUMN "locale" TEXT,
ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "timezoneId" TEXT;

-- Existing checks did not validate the locale environment. Require one new
-- successful check before any existing proxy can be assigned or opened.
UPDATE "Proxy"
SET "status" = 'CREATED',
    "lastCheckedAt" = NULL,
    "latencyMs" = NULL
WHERE "status" <> 'DISABLED';
