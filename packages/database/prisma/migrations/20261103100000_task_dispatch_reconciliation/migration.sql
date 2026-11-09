ALTER TABLE "Task" ADD COLUMN "dispatchedAt" TIMESTAMP(3);

CREATE INDEX "Task_status_dispatchedAt_idx" ON "Task"("status", "dispatchedAt");
