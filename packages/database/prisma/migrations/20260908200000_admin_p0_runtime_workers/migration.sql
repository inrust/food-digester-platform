-- P0：业务通知与 ESG 导出 Worker 的并发领取/崩溃恢复租约。
ALTER TABLE "esg_export_jobs"
  ADD COLUMN "claimed_at" TIMESTAMPTZ,
  ADD COLUMN "lease_until" TIMESTAMPTZ,
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "esg_export_jobs_status_created_at_idx";
CREATE INDEX "esg_export_jobs_status_lease_until_created_at_idx"
  ON "esg_export_jobs"("status", "lease_until", "created_at");

ALTER TABLE "notification_deliveries"
  ADD COLUMN "lease_until" TIMESTAMPTZ,
  ADD COLUMN "lease_token" TEXT;

CREATE INDEX "notification_deliveries_status_lease_until_created_at_idx"
  ON "notification_deliveries"("status", "lease_until", "created_at");
