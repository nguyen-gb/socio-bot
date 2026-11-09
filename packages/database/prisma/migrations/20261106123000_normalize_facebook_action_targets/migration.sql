-- Path-based Facebook post URLs are identified by their path. Remove copied
-- feed/comment tracking parameters so the same post cannot evade the global
-- COMMENT/REPLY deduplication ledger.
DELETE FROM "FacebookActionTarget" duplicate
USING "FacebookActionTarget" keeper
WHERE duplicate."id" <> keeper."id"
  AND duplicate."organizationId" = keeper."organizationId"
  AND duplicate."accountId" = keeper."accountId"
  AND duplicate."action" = keeper."action"
  AND duplicate."action" IN ('COMMENT', 'REPLY')
  AND split_part(duplicate."targetKey", '?', 1) = split_part(keeper."targetKey", '?', 1)
  AND duplicate."targetKey" > keeper."targetKey";

UPDATE "FacebookActionTarget"
SET "targetKey" = split_part("targetKey", '?', 1),
    "updatedAt" = NOW()
WHERE "action" IN ('COMMENT', 'REPLY')
  AND "targetKey" ~ '/(posts|permalink)/[^?]+\\?';
