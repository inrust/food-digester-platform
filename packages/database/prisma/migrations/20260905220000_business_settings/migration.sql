-- BE-SET-01：业务设置存储（封闭 key 集 + 乐观锁版本控制）。
-- key 集：alarm.thresholds（业务告警阈值）| command.confirmation（命令二次确认策略参数）|
-- dictionary.displayNames（字典显示名称，固定枚举只读防护）| notification.business（业务通知配置）。
-- 固定协议枚举（22 命令 / 11 Topic type / 13 Notification type）与 AWS 运维配置不得经此表改写（服务层强制）。
CREATE TABLE "business_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_settings_pkey" PRIMARY KEY ("key")
);

-- 初始值（命令确认参数与 packages/domain/src/command.ts 暂定值一致：TTL 300s / 未来漂移 60s）
INSERT INTO "business_settings" ("key", "value", "updated_by", "updated_at") VALUES
  ('alarm.thresholds', '{}'::jsonb, 'seed', CURRENT_TIMESTAMP),
  ('command.confirmation', '{"ttlSec":300,"maxFutureSec":60}'::jsonb, 'seed', CURRENT_TIMESTAMP),
  ('dictionary.displayNames', '{}'::jsonb, 'seed', CURRENT_TIMESTAMP),
  ('notification.business', '{"eventTypes":["CRITICAL_ALERT_RAISED","ALARM_STATE_CHANGED"],"channels":["EMAIL","WEBHOOK"]}'::jsonb, 'seed', CURRENT_TIMESTAMP);
