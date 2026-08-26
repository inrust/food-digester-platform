-- DB-01 种子字典（幂等：可重复执行）
-- 用法：psql "$DATABASE_URL" -f prisma/seed.sql

-- 角色字典（DEC-012 / 实施方案 12.1）
INSERT INTO "roles" ("code", "name", "description") VALUES
  ('PlatformSuperAdmin', '平台管理员', '全平台配置、审批和权限管理；强制 MFA'),
  ('PlatformOperator', '设备操作员', '客户、站点、设备、许可证、OTA 和命令操作；强制 MFA；不授予 AWS 资源权限'),
  ('Auditor', '审计员', '跨 Customer 只读、审计和报表导出；强制 MFA'),
  ('CustomerAdmin', '客户管理员', '仅管理所属 Customer 的设备用户、查看数据和有限命令'),
  ('CustomerViewer', '客户查看者', '所属 Customer 只读')
ON CONFLICT ("code") DO NOTHING;

-- ESG 计算方法基线版本
INSERT INTO "esg_calculation_versions" ("id", "version", "description", "effective_from", "status") VALUES
  ('00000000-0000-0000-0000-000000000001', '1.0.0', '试运营 ESG 计算方法基线（碳减排为估算值，界面须显示计算版本与数据完整性）', '2026-01-01T00:00:00Z', 'ACTIVE')
ON CONFLICT ("version") DO NOTHING;
