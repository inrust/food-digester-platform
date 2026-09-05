-- BE-RBAC-01：RBAC 角色种子（封闭集合，事实源 AUTH-01 packages/auth/src/roles.ts + DEC-012）。
-- 5 个角色与 Cognito User Pool Group（IAC-01 创建同名组）一一对应；V1 权限矩阵固定只读（DEC-012），
-- 角色集合不提供编辑 API，演进必须经决策变更 + 新 Migration。
INSERT INTO "roles" ("code", "name", "description") VALUES
  ('PlatformSuperAdmin', '平台管理员', '全平台配置、审批和权限管理（DEC-012：原型"平台管理员"映射）'),
  ('PlatformOperator', '设备操作员', '客户、站点、设备、许可证、OTA 和命令操作；无合约/角色/AWS 资源管理权限（DEC-012：原型"运维人员"映射，界面名设备操作员）'),
  ('Auditor', '审计人员', '跨 Customer 只读、审计和报表导出'),
  ('CustomerAdmin', 'Customer 管理员', '仅管理所属 Customer 的设备用户、查看数据和有限命令'),
  ('CustomerViewer', 'Customer 只读', '所属 Customer 只读')
ON CONFLICT ("code") DO NOTHING;
