-- BE-CUS-01：customers 增加乐观锁版本列（If-Match 防并发更新/停用/删除）
ALTER TABLE "customers" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
