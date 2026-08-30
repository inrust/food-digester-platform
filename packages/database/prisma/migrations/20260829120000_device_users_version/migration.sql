-- BE-DUSR-01：device_users 增加 version（乐观锁 If-Match + 设备同步版本）。
-- 任何用户/分配变化 version +1；USERS_CHANGED 通知后设备 Sync 按版本感知 Device Users 域变更。

ALTER TABLE "device_users" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
