UPDATE "FacebookCampaign" AS campaign
SET "createdByUserId" = (
  SELECT member."userId"
  FROM "OrganizationMember" AS member
  WHERE member."organizationId" = campaign."organizationId"
    AND member."role" = 'OWNER'
  ORDER BY member."createdAt" ASC
  LIMIT 1
)
WHERE campaign."createdByUserId" IS NULL;

UPDATE "Task" AS task
SET "createdByUserId" = COALESCE(
  (SELECT campaign."createdByUserId" FROM "FacebookCampaign" AS campaign WHERE campaign."id" = task."campaignId"),
  (SELECT member."userId"
   FROM "OrganizationMember" AS member
   WHERE member."organizationId" = task."organizationId"
     AND member."role" = 'OWNER'
   ORDER BY member."createdAt" ASC
   LIMIT 1)
)
WHERE task."createdByUserId" IS NULL;
