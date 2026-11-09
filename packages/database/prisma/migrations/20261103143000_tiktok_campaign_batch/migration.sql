ALTER TABLE "Task" ADD COLUMN "batchId" UUID;

CREATE INDEX "Task_organizationId_batchId_createdAt_idx"
ON "Task"("organizationId", "batchId", "createdAt");
