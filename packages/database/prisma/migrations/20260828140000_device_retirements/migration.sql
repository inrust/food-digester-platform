-- BE-SYNC-02 设备退役确认记录表：BE-DEV-04 管理员 retire 创建 PENDING_CONFIRMATION，
-- 设备 POST /api/v1/device/deactivate 确认（或 BE-DEV-04 force-complete）后 CONFIRMED 并完成证书停用
CREATE TABLE "device_retirements" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "reason" TEXT NOT NULL,
    "initiated_by" TEXT NOT NULL,
    "initiated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
    "confirmed_at" TIMESTAMP(3) WITH TIME ZONE,
    "completion_method" TEXT,
    "certificate_revoked_at" TIMESTAMP(3) WITH TIME ZONE,
    "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_retirements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_retirements_device_id_fkey"
      FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Retired 永久不可恢复（DOM-01 无出边），每台设备至多一条退役记录
CREATE UNIQUE INDEX "device_retirements_device_id_key" ON "device_retirements"("device_id");
