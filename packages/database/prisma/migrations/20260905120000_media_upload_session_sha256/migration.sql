-- BE-MED-01：Media 上传会话记录设备申报的 SHA-256（hex64）。
-- 上传后 Media Handler 重算对象 Hash 并与申报值比对，不匹配拒绝（验收基准：Hash 不符拒绝）。
-- 可空：历史/异常数据兼容；BE-MED-01 起创建会话必填（API 层强制）。
ALTER TABLE "media_upload_sessions" ADD COLUMN "declared_sha256" TEXT;
