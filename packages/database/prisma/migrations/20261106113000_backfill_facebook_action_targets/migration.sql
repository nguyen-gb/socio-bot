WITH report_entries AS (
  SELECT t.*, tr."finishedAt", tr."startedAt", entry
  FROM "Task" t
  JOIN "TaskRun" tr ON tr."taskId" = t."id"
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tr."result"->'report'->'entries', '[]'::jsonb)) entry
  WHERE t."platform" = 'FACEBOOK' AND t."status" = 'SUCCEEDED'
), completed_targets AS (
  SELECT "organizationId", "accountId", "id" AS "taskId", 'MESSAGE' AS action,
    entry->>'profileUrl' AS "targetKey", COALESCE("finishedAt", "startedAt", NOW()) AS "completedAt"
  FROM report_entries
  WHERE action IN ('MESSAGE_FACEBOOK_RECIPIENT', 'MESSAGE_FACEBOOK_REACTOR') AND entry ? 'profileUrl'
  UNION ALL
  SELECT "organizationId", "accountId", "id", 'JOIN',
    rtrim(payload->>'groupUrl', '/') || '/', COALESCE("finishedAt", "startedAt", NOW())
  FROM report_entries WHERE action = 'JOIN_FACEBOOK_GROUP' AND payload ? 'groupUrl'
  UNION ALL
  SELECT "organizationId", "accountId", "id", 'POST',
    rtrim(payload->>'groupUrl', '/') || '/|' || trim(regexp_replace(COALESCE(payload->>'text', ''), '\s+', ' ', 'g')),
    COALESCE("finishedAt", "startedAt", NOW())
  FROM report_entries WHERE action = 'POST_FACEBOOK_GROUP' AND payload ? 'groupUrl'
  UNION ALL
  SELECT "organizationId", "accountId", "id", 'REPLY', payload->>'postUrl', COALESCE("finishedAt", "startedAt", NOW())
  FROM report_entries WHERE action = 'REPLY_FACEBOOK_POST_COMMENTS' AND payload ? 'postUrl'
  UNION ALL
  SELECT "organizationId", "accountId", "id", 'COMMENT', entry->>'postUrl', COALESCE("finishedAt", "startedAt", NOW())
  FROM report_entries
  WHERE action = 'COMMENT_FACEBOOK_GROUP_POSTS' AND entry ? 'postUrl' AND entry->>'status' IN ('SENT', 'SUCCEEDED')
)
INSERT INTO "FacebookActionTarget" (
  "id", "organizationId", "accountId", "taskId", "action", "targetKey",
  "status", "reservedAt", "completedAt", "createdAt", "updatedAt"
)
SELECT md5("taskId"::text || ':' || action || ':' || "targetKey")::uuid,
  "organizationId", "accountId", "taskId", action, "targetKey",
  'COMPLETED', "completedAt", "completedAt", "completedAt", NOW()
FROM completed_targets
WHERE "targetKey" IS NOT NULL AND "targetKey" <> ''
ON CONFLICT ("organizationId", "accountId", "action", "targetKey") DO NOTHING;
