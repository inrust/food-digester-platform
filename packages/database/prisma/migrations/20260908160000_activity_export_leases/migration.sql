-- BE-DEV-05 P0：活动导出 Worker 租约恢复。
-- PROCESSING Worker 崩溃后由 lease_until 到期重新认领；attempt_count 保留可观测重试次数。
ALTER TABLE "device_activity_export_jobs"
ADD COLUMN "claimed_at" TIMESTAMPTZ,
ADD COLUMN "lease_until" TIMESTAMPTZ,
ADD COLUMN "lease_token" TEXT,
ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "device_activity_export_jobs_status_created_at_idx";
CREATE INDEX "device_activity_export_jobs_status_lease_until_created_at_idx"
ON "device_activity_export_jobs" ("status", "lease_until", "created_at");
