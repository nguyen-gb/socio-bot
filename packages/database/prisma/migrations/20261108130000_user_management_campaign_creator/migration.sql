ALTER TABLE "Task" ADD COLUMN "createdByUserId" UUID;
ALTER TABLE "FacebookCampaign" ADD COLUMN "createdByUserId" UUID;

CREATE INDEX "Task_createdByUserId_idx" ON "Task"("createdByUserId");
CREATE INDEX "FacebookCampaign_createdByUserId_idx" ON "FacebookCampaign"("createdByUserId");

ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FacebookCampaign" ADD CONSTRAINT "FacebookCampaign_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
