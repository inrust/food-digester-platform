# BE-ALM-01 Alarm/Event/Tamper 查询与处理 API

实现：[apps/cloud-api/src/admin/alarm/](../../apps/cloud-api/src/admin/alarm/index.ts)（errors/service/handler）；领域：[packages/domain/src/alarm.ts](../../packages/domain/src/alarm.ts)；OpenAPI：[contracts/rest/admin-alarm-api.json](../../contracts/rest/admin-alarm-api.json)；验收测试：[admin-alarm.test.ts](../../apps/cloud-api/test/admin-alarm.test.ts)。

> 证据治理：当前本地全仓证据命令为 `pnpm verify`；精确快照与整改闭环见 [全面复盘检查报告](../audit/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md)。目标 AWS 验收必须按 [证据采集说明](../audit/evidence/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md) 生成与待发布提交绑定的回执，并通过 `pnpm check:aws-admin-business-evidence`；缺失回执不得以本地测试替代。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ALM-01（P1 / 管理后台后端），依赖 AUTH-01、DB-02、DOM-03（均已交付） |
| 写入侧 | BE-IOT-07（已交付）：设备上报 ACTIVE 插入新行、CLEARED 条件关闭同 code ACTIVE 行；本任务只做管理端查询与处理，不创建 Alarm |
| 功能边界 | 不实现 AWS 资源运维告警和人工值守 |

## 2. 端点与关键设计

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/admin/alarms` | alarm:read（全角色） | severity/status/deviceId/siteId（经设备归属解析）/customerId/detectedTime 范围筛选 + 键集游标分页（id ASC，`meta.nextCursor`） |
| `GET /api/v1/admin/alarms/{alarmId}` | alarm:read | 跨 Customer → 404（不泄露存在性） |
| `POST /api/v1/admin/alarms/{alarmId}/acknowledge` | alarm:write（SuperAdmin/Operator） | ACTIVE→ACKNOWLEDGED；强制 reason（1~500）；记录操作者/原因/时间落库 + 审计 |
| `POST /api/v1/admin/alarms/{alarmId}/clear` | alarm:write | ACTIVE/ACKNOWLEDGED→CLEARED；强制 reason |
| `GET /api/v1/admin/events` | alarm:read | Event 只读列表（eventType/时间范围等筛选 + 游标） |
| `GET /api/v1/admin/tamper-events` | alarm:read | Tamper 只读列表（+severity 筛选） |

**状态机**（领域层 `ALARM_ADMIN_TRANSITIONS`）：ACTIVE→ACKNOWLEDGED→CLEARED、ACTIVE→CLEARED；终态 CLEARED 无出边（确认已清除 → 409 CONFLICT）。并发兜底：条件 `updateMany`（`where id+status=from`，漂移 → 409）。

**幂等**：目标状态已达成（重复确认/重复清除）→ 200 `replayed=true`，无写入/审计/领域事件，且不覆盖首次操作记录。

**Critical 领域通知**：仅当 CRITICAL 告警发生真实状态迁移时，同事务发布恰好一个 `ALARM_STATE_CHANGED` Outbox 领域事件（aggregateType=alarm，payload 含 fromStatus/toStatus/severity/actorId/occurredAt），供通知适配器消费（BE-ALM-02）；非 CRITICAL 迁移与幂等重放均不产生事件——领域通知只在状态变化时产生。

**租户隔离**：Customer 角色列表强制所属 Customer scope（显式传其他 customerId 被覆盖）；跨 Customer 详情 → 404；Customer 角色无 alarm:write（权限门 403，不触达存在性判定）。

**审计**：DOM-03 `audited`，action `alarm.acknowledge`/`alarm.clear`，含操作者、原因、前后状态。

**Schema 变更**：migration `20260830100000_alarm_handling_columns` 为 alarms 表补 `acknowledge_reason`/`cleared_by`/`clear_reason`（设备上报清除的 clearedBy/clearReason 为 null，与管理端清除可区分）。

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 筛选和游标分页正确 | severity/status/deviceId/siteId/时间范围逐项断言；非法枚举 400；limit=1 三页游标不重复不缺行、末页 nextCursor=null | ✅ |
| 重复确认幂等 | 重复确认/重复清除 → replayed=true，无新写入（原因不覆盖）/审计/领域事件 | ✅ |
| 跨 Customer 查询失败 | Customer 角色列表仅见本 Customer（显式 customerId 被覆盖）；跨 Customer 详情 404；Customer 角色写 403 | ✅ |
| 领域通知只在状态变化时产生 | CRITICAL 真实迁移恰好 1 个 ALARM_STATE_CHANGED（payload 校验）；MAJOR 迁移 0 个；重放 0 新增 | ✅ |
| 确认/清除记录操作者、原因和时间 | acknowledgedBy/acknowledgeReason/acknowledgedAt、clearedBy/clearReason/clearedAt 落库断言 + alarm.acknowledge/alarm.clear 审计各 1 条 | ✅ |
| 权限矩阵 | CustomerAdmin/Auditor 写 → 403；CustomerViewer 读放行 | ✅ |
| Event/Tamper 只读 | eventType/severity/时间筛选、details 透传、租户隔离 | ✅ |
| 契约一致性 | 响应字段与 OpenAPI 封闭一致（Alarm/AlarmHandleResult/DeviceEvent/TamperEvent）；错误码对齐 CT-05；模块无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-alarm-api.test.ts`（覆盖端点、认证、响应码、筛选参数、Schema 封闭与强制原因、$ref 可解析）。

## 4. 未决风险

- Alarm 无 version 列：处理并发兜底依赖状态条件更新（无 If-Match）；如需更强的读取-修改一致性语义，需新增 version 列（待任务定义）；
- `ALARM_STATE_CHANGED` 领域事件的下游通知适配器（通知记录生成/1 分钟时限/去重）属 BE-ALM-02 范围，本任务仅保证事件恰好一次且仅在状态变化时产生；
- Event/Tamper 无详情端点（任务定义为只读查询，列表已覆盖详情字段）；
- siteId 筛选经设备归属二次查询解析（alarms/events/tamper 无 site 列），站点设备量极大时需关注 IN 列表规模。
