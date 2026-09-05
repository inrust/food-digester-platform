-- P1 审计整改：持久化 DOM-01 双轴状态历史。
-- 旧数据在历史实现中已丢失 axis，无法无歧义恢复；保守标记为 lifecycle，
-- 新写入方从领域 effects 明确持久化 lifecycle/operational。
CREATE TYPE "DeviceStateAxis" AS ENUM ('lifecycle', 'operational');

ALTER TABLE "device_state_history" ADD COLUMN "axis" "DeviceStateAxis";
UPDATE "device_state_history" SET "axis" = 'lifecycle' WHERE "axis" IS NULL;
ALTER TABLE "device_state_history" ALTER COLUMN "axis" SET NOT NULL;
