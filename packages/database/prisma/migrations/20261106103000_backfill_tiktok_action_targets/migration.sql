WITH completed_targets AS (
  SELECT
    t."organizationId",
    t."accountId",
    t."id" AS "taskId",
    entry->>'action' AS "action",
    CASE
      WHEN entry->>'action' = 'MESSAGE'
        THEN lower(regexp_replace(entry->>'username', '^@', ''))
      ELSE regexp_replace(split_part(split_part(entry->>'videoUrl', '#', 1), '?', 1), '/$', '')
    END AS "targetKey",
    COALESCE(tr."finishedAt", tr."startedAt", NOW()) AS "completedAt"
  FROM "Task" t
  JOIN "TaskRun" tr ON tr."taskId" = t."id"
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tr."result"->'report'->'entries', '[]'::jsonb)) entry
  WHERE t."platform" = 'TIKTOK'
    AND entry->>'action' IN ('COMMENT', 'REPLY', 'LIKE', 'MESSAGE')
    AND entry->>'status' IN ('SENT', 'LIKED')
)
INSERT INTO "TikTokActionTarget" (
  "id", "organizationId", "accountId", "taskId", "action", "targetKey",
  "status", "reservedAt", "completedAt", "createdAt", "updatedAt"
)
SELECT
  md5("taskId"::text || ':' || "action" || ':' || "targetKey")::uuid,
  "organizationId", "accountId", "taskId", "action", "targetKey",
  'COMPLETED', "completedAt", "completedAt", "completedAt", NOW()
FROM completed_targets
WHERE "targetKey" IS NOT NULL AND "targetKey" <> ''
ON CONFLICT ("organizationId", "accountId", "action", "targetKey") DO NOTHING;
