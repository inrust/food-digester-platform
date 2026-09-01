-- BE-ALM-02 业务通知适配器：Customer 通知配置 + 投递记录（发送状态与幂等键）。

CREATE TABLE "customer_notification_configs" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_recipients" JSONB NOT NULL DEFAULT '[]',
    "webhook_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customer_notification_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_notification_configs_customer_id_key" ON "customer_notification_configs" ("customer_id");

CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    -- 幂等键：eventId:channel:target（重复事件/重复派发只产生一条投递记录）
    "idempotency_key" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_deliveries_idempotency_key_key" ON "notification_deliveries" ("idempotency_key");
CREATE INDEX "notification_deliveries_status_created_at_idx" ON "notification_deliveries" ("status", "created_at");
CREATE INDEX "notification_deliveries_customer_id_created_at_idx" ON "notification_deliveries" ("customer_id", "created_at");
