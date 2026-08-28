-- BE-ARC-01：outbox_events 发布重试信息（原子记录发布时间 published_at 已有；补充重试计数与最近错误）
ALTER TABLE "outbox_events" ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "outbox_events" ADD COLUMN "last_error" TEXT;
