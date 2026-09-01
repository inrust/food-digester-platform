-- BE-ALM-01：告警确认/清除记录操作者、原因和时间。
-- acknowledgedBy/acknowledgedAt/clearedAt 已存在；补充 acknowledge_reason / cleared_by / clear_reason。

ALTER TABLE "alarms" ADD COLUMN "acknowledge_reason" TEXT;
ALTER TABLE "alarms" ADD COLUMN "cleared_by" TEXT;
ALTER TABLE "alarms" ADD COLUMN "clear_reason" TEXT;
