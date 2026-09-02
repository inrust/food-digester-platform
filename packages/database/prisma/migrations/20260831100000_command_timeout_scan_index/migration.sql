-- BE-CMD-03：Timeout evaluator 按 (status, expiresAt) 扫描未完成命令；补充索引（Expand 阶段，仅加索引不改语义）。
-- 同时修正 command_acks.result 注释语义由代码保证（SUCCESS | FAILED | RECEIVED），表结构无需变更。

CREATE INDEX "device_commands_status_expires_idx" ON "device_commands" ("status", "expires_at");
