# DEC-001 Maintenance 行为矩阵

DEC-001 是协议冻结门禁决策（当前 `pending`，登记版本 `0.2.0`）。按《管理后台开发任务清单》§4 末段——"在决策未确认时，相关任务可实现扩展点、类型和测试夹具，但不得把暂定值固化为不可迁移的数据结构"——本任务把暂定值落地为数据驱动、可整体替换的行为矩阵扩展点。**决策本身未冻结，冻结必须经业务方批准人按 [decision-change-template.md](../contracts/decisions/decision-change-template.md) 执行。**

## 暂定值（provisional）

> Maintenance 为独立状态；暂按 Suspended 限制，但允许维护、同步、遥测、告警和 OTA。

| 行为 | 暂定结论 | 消费任务 |
|---|---|---|
| `SYNC`（Unified Device Sync） | 允许；节奏 900 秒（Suspended 的 15 分钟）；重连/Notification 后立即调用不变 | BE-SYNC-01 |
| `MAINTENANCE_COMMANDS`（维护/诊断/安全停止/同步/恢复类命令） | 允许；白名单引用 command-catalog.json 的 MAINTENANCE 列 | BE-CMD-01、BE-CMD-02、DOM-01 |
| `PROCESSING_COMMANDS`（启动处理类命令） | 拒绝，与 Suspended 一致 | BE-CMD-01、BE-CMD-02 |
| `TELEMETRY_INGESTION`（遥测上行） | 允许；接收/校验/幂等/归档与最新状态投影不因 Maintenance 中断 | DOM-01 |
| `ALARM_EVENT_TAMPER_PROCESSING`（告警/事件/Tamper 上行） | 允许；Tamper 自动挂起策略不受影响 | DOM-01 |
| `OTA`（固件下发与状态接收） | 允许；仍需 OTA Entitlement 与 Campaign 目标校验 | DOM-01、BE-CMD-01 |
| `RETIREMENT`（退役工作流） | 允许；退役顺序不变 | BE-DEV-04 |

未列出的行为一律失败关闭（`fallbackPolicy: deny`），禁止默认放行。

## 文件

| 文件 | 说明 |
|---|---|
| [contracts/lifecycle/maintenance-behavior-matrix.json](../contracts/lifecycle/maintenance-behavior-matrix.json) | 矩阵数据事实源（`matrixVersion`、`x-decision-versions`、`behaviors`） |
| [contracts/lifecycle/maintenance-behavior-matrix.schema.json](../contracts/lifecycle/maintenance-behavior-matrix.schema.json) | 矩阵结构契约（封闭行为键集合） |
| [contracts/lifecycle/maintenance-behavior.ts](../contracts/lifecycle/maintenance-behavior.ts) | 类型与查询函数（`isMaintenanceBehaviorAllowed`、`getMaintenanceSyncIntervalSeconds`、`isMaintenanceCommandAllowed`、`maintenanceCommandDenyReason`），命令判定委托 command-catalog |
| [contracts/lifecycle/maintenance-behavior.test.ts](../contracts/lifecycle/maintenance-behavior.test.ts) | 结构、负向、一致性与阻塞任务覆盖测试 |

## 使用约束

1. 消费方（DOM-01、BE-SYNC-01、BE-DEV-04、BE-CMD-01、BE-CMD-02）只能经 `maintenance-behavior.ts` 查询，禁止直接读 JSON 字段或复制暂定值到代码/数据库；
2. 命令允许集合的唯一事实源仍是 `command-catalog.json` 的 `allowedStatuses`，矩阵不重复列举命令；
3. Maintenance 是独立 Operational 状态（DEC-010 四轴之一），不是 Suspended 的别名；状态迁移与 `state_history` 由 DOM-01 负责；
4. `status: provisional` 期间，任何持久化设计不得把本矩阵值固化为不可迁移结构。

## 冻结升级路径

1. 业务方按决策变更模板批准 DEC-001，登记升至 `>= 1.0.0`、状态 `frozen`；
2. 整体替换矩阵文件并提升 `matrixVersion` 至 `>= 1.0.0`、`status` 改 `frozen`，同步更新 `x-decision-versions`；
3. 运行下方验证命令；消费方代码无需修改（数据驱动）。

## 验证命令

```bash
# 本矩阵测试（结构/负向/一致性/覆盖）
node --test "contracts/lifecycle/maintenance-behavior.test.ts"

# 决策登记结构 + 契约版本一致
node scripts/check-decisions.mjs

# 追溯校验：矩阵与 command-catalog 的 x-decision-versions 与登记一致
node scripts/check-decisions.mjs trace \
  contracts/lifecycle/maintenance-behavior-matrix.json \
  contracts/mqtt/command-catalog.json
```
