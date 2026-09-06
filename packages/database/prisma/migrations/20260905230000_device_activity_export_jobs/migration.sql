-- BE-DEV-05：设备活动异步 CSV 导出任务（冻结筛选快照、行数、短期下载 URL 过期时点；
-- 不长期托管导出文件——存储对象由部署层生命周期策略清理，本表仅存引用与过期语义）。
CREATE TABLE "device_activity_export_jobs" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "requested_by" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "row_count" INTEGER,
    "storage_key" TEXT,
    "download_url" TEXT,
    "url_expires_at" TIMESTAMPTZ,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "device_activity_export_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "device_activity_export_jobs_status_created_at_idx" ON "device_activity_export_jobs" ("status", "created_at");
CREATE INDEX "device_activity_export_jobs_customer_id_created_at_idx" ON "device_activity_export_jobs" ("customer_id", "created_at");
