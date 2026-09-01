-- BE-ESG-02：异步 CSV 导出任务（发送状态、行数、短期下载 URL 过期时点；不长期托管导出文件——
-- 存储对象由部署层生命周期策略清理，本表仅存引用与过期语义）。

CREATE TABLE "esg_export_jobs" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT,
    "requested_by" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "row_count" INTEGER,
    "storage_key" TEXT,
    "download_url" TEXT,
    "url_expires_at" TIMESTAMPTZ,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "esg_export_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "esg_export_jobs_status_created_at_idx" ON "esg_export_jobs" ("status", "created_at");
CREATE INDEX "esg_export_jobs_customer_id_created_at_idx" ON "esg_export_jobs" ("customer_id", "created_at");
