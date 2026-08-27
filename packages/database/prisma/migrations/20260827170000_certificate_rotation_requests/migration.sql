-- BE-CERT-03 管理员证书轮换请求表
CREATE TABLE "certificate_rotation_requests" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "certificate_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_by" TEXT NOT NULL,
    "notified_at" TIMESTAMP(3) WITH TIME ZONE,
    "completed_at" TIMESTAMP(3) WITH TIME ZONE,
    "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_rotation_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "certificate_rotation_requests_device_id_fkey"
      FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "certificate_rotation_requests_device_id_status_idx"
  ON "certificate_rotation_requests"("device_id", "status");

-- 幂等约束：每台设备同时至多一个 PENDING 轮换请求（重复点击/并发发起由该索引兜底）
CREATE UNIQUE INDEX "certificate_rotation_requests_one_pending_per_device"
  ON "certificate_rotation_requests"("device_id") WHERE "status" = 'PENDING';
