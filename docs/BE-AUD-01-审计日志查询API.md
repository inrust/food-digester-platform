# BE-AUD-01 审计日志查询 API

实现：[apps/cloud-api/src/admin/audit](../apps/cloud-api/src/admin/audit)（errors/service/handler）；REST 契约 [admin-audit-api.json](../contracts/rest/admin-audit-api.json)；验收测试 [admin-audit.test.ts](../apps/cloud-api/test/admin-audit.test.ts)（PGlite）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-AUD-01（P1 / 管理后台后端），依赖 DOM-03（append-only 审计 + sanitizeAuditPayload 脱敏）、AUTH-01（audit:read 权限矩阵 + withAuthorization） |
| 事实源 | DOM-03 audit_logs 表（写入时已脱敏）；DEC-012@1.0.0（V1 权限矩阵固定只读——audit:read 仅 PlatformSuperAdmin/Auditor 持有） |
| Schema 变更 | 无（复用 DOM-03 audit_logs 及其 customerId+createdAt / objectType+objectId 索引） |
| 功能边界 | 不查询 CloudTrail 和基础设施日志；不提供任何修改/删除路由（append-only 另由 repository 拦截器强制） |

## 2. 关键设计

**路由**（全部 audit:read + CognitoJwt）：`GET /api/v1/admin/audit-logs` 列表；`GET /api/v1/admin/audit-logs/{auditId}` 详情。

**筛选与分页**：actorId / customerId / objectType / objectId / action / result（SUCCESS|FAILURE 封闭枚举）/ createdAt 时间范围（from/to，UTC 含端点）；排序 createdAt 倒序 + id 决胜，键集游标为复合键 `${createdAtIso}|${id}`（复用共享游标编码 decode/encodeKeysetCursor），相同时间戳翻页不重复不漏。

**权限隔离**：Auditor/PlatformSuperAdmin 跨 Customer 只读；PlatformOperator 与 Customer 角色无 audit:read（DEC-012 冻结矩阵 → handler 403）。服务层对 Customer actor 仍强制 actor.customerId 租户隔离（customerId 参数不一致 → 403；详情跨 Customer → 404 不泄露存在性）作为纵深防御——若未来矩阵经版本化决策向 Customer 角色开放 audit:read，隔离语义即刻生效。

**脱敏保证（敏感字段永不返回）**：写入与读取共用递归脱敏器；字段名覆盖 Authorization、Cookie/Set-Cookie、session、JWT、password、token、secret、private key 等常见大小写/分隔变体，值模式额外识别 Bearer、JWT、Session Cookie 与私钥，非标准字段名也不能绕过。

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 权限隔离 | Auditor/SuperAdmin 跨 Customer 200；Operator/CustomerAdmin → 403；无 actor → 401；Customer actor 服务层强制 scope、越权筛选 FORBIDDEN、跨 Customer 详情 NOT_FOUND | ✅ |
| 筛选正确 | actorId/customerId/objectType/objectId/action/result/from/to 各自生效；非法 result/日期 → 400 | ✅ |
| 分页正确 | createdAt 倒序 + id 决胜；5 条相同时间戳记录 limit=2 翻页不重复不漏且与全量顺序一致 | ✅ |
| 敏感字段永不返回 | password/privateKey/apiToken、Authorization、Cookie/Set-Cookie、嵌套数组，以及非标准键下的 Bearer/JWT 值均在写入和读取侧变为 [REDACTED] | ✅ |
| 不存在写路由 | handler 仅导出 listAuditLogs/getAuditLogDetail；契约测试强制 OpenAPI 无 post/put/patch/delete | ✅ |

## 4. 未决风险

- **Customer 角色审计可见性**：V1 冻结矩阵（DEC-012）未授予 Customer 角色 audit:read，故「Customer 角色仅自身」当前以服务层强制隔离 + handler 403 落地；如需向 Customer 角色开放自身审计查询，须另立版本化决策修订矩阵（服务层隔离语义已就绪）。
- **复合游标为模块内格式**：`${createdAtIso}|${id}` 复用共享游标编码但键结构为本模块私有；若其他模块需要时间倒序分页，可上提为共享复合游标助手。
- **审计查询本身的审计**：查询为只读操作，按 DOM-03 口径不写审计（与既有只读端点一致）；如需审计「谁看了审计」，需另立决策。

## 5. 状态边界与发布 Gate

- `module implemented`：统一写入/读取脱敏、查询契约与本地回归已实现。
- `production wired`：Admin Router 与 Lambda 组合根已接线。
- `target verified`：**NOT RUN**；尚无真实 Cognito 角色、跨租户与敏感值读回证据。
- 本地统一验证：`pnpm verify`。历史审计快照：[BE-MED-RBAC-AUD-DASH-SET 全面复盘检查报告](audit/BE-MED-RBAC-AUD-DASH-SET全面复盘检查报告-2026-09-09.md)。
- 发布证据：[BE-MED/RBAC/AUD/DASH/SET AWS 验收证据采集说明](audit/evidence/BE-MED-RBAC-AUD-DASH-SET-AWS验收证据采集说明.md)，执行 `pnpm check:aws-med-rbac-aud-dash-set-evidence`。
