CREATE TYPE "TaskApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Task"
  ADD COLUMN "approvalStatus" "TaskApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "approvedByUserId" UUID,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3);

CREATE INDEX "Task_organizationId_approvalStatus_idx"
  ON "Task"("organizationId", "approvalStatus");

ALTER TABLE "Task" ADD CONSTRAINT "Task_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
