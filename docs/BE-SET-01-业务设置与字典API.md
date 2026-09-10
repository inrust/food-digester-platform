# BE-SET-01 业务设置与字典 API

实现：[apps/cloud-api/src/admin/settings](../apps/cloud-api/src/admin/settings)（errors/service/handler）；存储模型 `business_settings`（[migration 20260905220000](../packages/database/prisma/migrations/20260905220000_business_settings/migration.sql)）；REST 契约 [admin-settings-api.json](../contracts/rest/admin-settings-api.json)；验收测试 [admin-settings.test.ts](../apps/cloud-api/test/admin-settings.test.ts)（PGlite）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-SET-01（P2 / 管理后台后端），依赖 AUTH-01（settings:read/write 权限矩阵）、DOM-03（审计） |
| 事实源 | 封闭 key 集 4 项：alarm.thresholds / command.confirmation / dictionary.displayNames / notification.business；固定协议枚举事实源：COMMAND_CATALOG（22 命令，@fdp/domain）、UPLINK/DOWNLINK_TOPIC_TYPES（11 Topic type，contracts/mqtt/topics）、NOTIFICATION_CATALOG（13 类型，contracts/mqtt/catalogs）、NOTIFIABLE_EVENT_TYPES/NOTIFICATION_CHANNELS（notification 模块） |
| Schema 变更 | 新增 `business_settings`（key PK + value JSONB + version 乐观锁 + updatedBy）并种子 4 项初始值（命令确认参数与 DEC-023 冻结值一致：TTL 300s / 未来漂移 60s） |
| 功能边界 | 不管理 CloudWatch 告警、资源阈值或 Budget；不改写固定协议枚举、Topic 或 AWS 运维配置 |

## 2. 关键设计

**路由**：`GET /api/v1/admin/settings`（列表）、`GET /{key}`、`PUT /{key}`。读取 settings:read（PlatformSuperAdmin/Auditor）；写入 settings:write（仅 PlatformSuperAdmin，DEC-012 固定矩阵）。无新建/删除路由——未知 key → 404（封闭集之外不可创建）。

**版本控制（并发修改冲突）**：PUT 必须回传当前 version；条件更新 `where {key, version}` + 自增，count ≠ 1 → 409 VERSION_CONFLICT；version 缺失/非正整数 → 400。全部写操作经 `audited` 写 `settings.update` 审计（before/after 含 value 与 version）。

**严格请求与运行状态**：PUT 顶层只允许 `value/version`；未知字段、数组或其他非对象 body 在 DB/审计前返回 400。响应对每项返回 `runtimeStatus/runtimeConsumer`：`command.confirmation` 为 `ACTIVE/BE-CMD-01`；其余三项为 `STORED_ONLY/null`，更新成功仅代表配置已校验、版本化并审计，不代表告警、界面显示名或通知派发行为已生效。

**值 Schema（非法配置拒绝，400 且不落库）**：
- alarm.thresholds：`{ alarmCode: { warning?, major?, critical? } }`——非负数值、同 code 内 warning ≤ major ≤ critical、至少一级、无未知字段；
- command.confirmation：仅 `{ ttlSec: 30..3600, maxFutureSec: 0..600 }`——携带 highRiskCommands 等重定义固定命令目录的字段 → 400（命令高风险属性协议固定）；
- dictionary.displayNames：`{ command|topicType|notificationType: { code: 显示名 } }`——code 必须属于固定封闭集（22 命令 / 11 Topic type / 13 Notification type），未知 code/namespace → 400；显示名 1..64 字符。**固定命令/Topic 不可被删除或重命名**：本 API 仅维护已知 code 的显示名，枚举定义本身在代码/契约中，不经过设置表；
- notification.business：`{ eventTypes, channels }`——封闭事件/渠道非空子集、无重复。

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 非法配置拒绝 | 阈值层级倒置/负值/未知字段/空条目；ttlSec 越界/非整数/缺字段/highRiskCommands 重定义；未知通知事件/渠道/空数组/重复；均 400 且不落库 | ✅ |
| 并发修改冲突 | 携带过期 version → 409 VERSION_CONFLICT 且值未变；正确 version 可继续更新 | ✅ |
| 固定命令/Topic 不可删除或重命名 | 未知 command/topicType/notificationType code、未知 namespace → 400；已知 code 显示名放行且枚举本身不被改写 | ✅ |
| 版本控制与审计 | 更新成功 version 自增 + updatedBy；settings.update 审计 before/after 齐备 | ✅ |
| 权限 | Auditor 可读不可写（403）；Operator/Customer 角色读写皆 403；无 actor → 401 | ✅ |

## 4. 未决风险

- **设置消费边界**：`command.confirmation` 已由 BE-CMD-01 读取并失败关闭；`alarm.thresholds`、`dictionary.displayNames`、`notification.business` 明确为 `STORED_ONLY`，后续接入业务消费方时须另立任务并把状态改为 ACTIVE。
- **business_settings 与 customer_notification_configs 分工**：本表为全局业务通知策略；Customer 级通知开关/收件人仍在 CustomerNotificationConfig（无管理 API，留待后续任务）。
- **并发 FAILURE 审计**：409 冲突经 audited 记录 FAILURE 审计（含失败原因），属 DOM-03 口径的正常噪声。

## 5. 状态边界与发布 Gate

- `module implemented`：严格请求、配置校验、版本、审计及运行状态投影已实现。
- `production wired`：Admin Router 与 Lambda 组合根已接线；仅 `command.confirmation` 有运行时消费方。
- `target verified`：**NOT RUN**；目标 RDS 版本竞态、角色授权及设置读写尚无真实回执。
- 本地统一验证：`pnpm verify`。历史审计快照：[BE-MED-RBAC-AUD-DASH-SET 全面复盘检查报告](audit/BE-MED-RBAC-AUD-DASH-SET全面复盘检查报告-2026-09-09.md)。
- 发布证据：[BE-MED/RBAC/AUD/DASH/SET AWS 验收证据采集说明](audit/evidence/BE-MED-RBAC-AUD-DASH-SET-AWS验收证据采集说明.md)，执行 `pnpm check:aws-med-rbac-aud-dash-set-evidence`。
