-- BE-CFG-01：device_configurations 支持按设备发布（target_model / target_device_id 二选一，CHECK 兜底）
ALTER TABLE "device_configurations" ADD COLUMN "target_device_id" TEXT;
ALTER TABLE "device_configurations"
  ADD CONSTRAINT "device_configurations_exactly_one_target"
  CHECK ((("target_model" IS NOT NULL)::integer + ("target_device_id" IS NOT NULL)::integer) = 1);
CREATE INDEX "device_configurations_target_device_id_idx" ON "device_configurations"("target_device_id");
