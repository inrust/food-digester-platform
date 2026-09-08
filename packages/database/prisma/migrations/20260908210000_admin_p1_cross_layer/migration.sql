-- P1：保存通知提供方回执；PROCESSING 状态使用 P0 已增加的 lease 字段原子领取。
ALTER TABLE "notification_deliveries"
  ADD COLUMN "provider_request_id" TEXT;
