-- FE-09 P1：记录 Device User 版本进入设备 Sync 快照及后续 lastSyncTime 确认。
-- 该记录不代表设备已经在本地应用快照内容。
CREATE TABLE "device_user_sync_receipts" (
  "id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "device_user_id" TEXT NOT NULL,
  "entity_version" INTEGER NOT NULL,
  "served_at" TIMESTAMPTZ NOT NULL,
  "device_reported_last_sync_at" TIMESTAMPTZ,
  "acknowledged_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "device_user_sync_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_user_sync_receipts_device_id_device_user_id_entity_v_key"
    UNIQUE ("device_id", "device_user_id", "entity_version"),
  CONSTRAINT "device_user_sync_receipts_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "device_user_sync_receipts_device_user_id_fkey"
    FOREIGN KEY ("device_user_id") REFERENCES "device_users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "device_user_sync_receipts_device_user_id_served_at_idx"
  ON "device_user_sync_receipts"("device_user_id", "served_at");

CREATE INDEX "device_user_sync_receipts_device_id_served_at_idx"
  ON "device_user_sync_receipts"("device_id", "served_at");
