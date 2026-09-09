# BE-CMD-03 ACK/Timeout 状态机与查询 API

实现：
- 领域状态机：[packages/domain/src/command.ts](../packages/domain/src/command.ts)（`classifyAck`/`COMMAND_STATUSES`/`COMMAND_UNFINISHED_STATUSES`/`isCommandExpired`，纯函数）
- ACK Handler：[apps/ingestion-worker/src/signals/ack.ts](../apps/ingestion-worker/src/signals/ack.ts)（`bnx/device/{deviceId}/ack` 上行）
- Timeout evaluator：[apps/cloud-api/src/admin/command/timeout.ts](../apps/cloud-api/src/admin/command/timeout.ts)（可注入时钟）
- 查询 API：[query-service.ts](../apps/cloud-api/src/admin/command/query-service.ts) + [handler.ts](../apps/cloud-api/src/admin/command/handler.ts)（GET 列表/详情）
- 契约：[contracts/rest/admin-command-api.json](../contracts/rest/admin-command-api.json)（新增 2 端点 + CommandStatus/ListItem/Detail/Ack/Attempt Schema）

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CMD-03（P1），依赖 BE-CMD-02（PUBLISHED 命令）、DB-02（键集游标/事务模式） |
| ACK 契约 | contracts/mqtt/schemas/ack.schema.json：meta.seq 必填（上行）；data.commandId/command/result(SUCCESS\|FAILED，可缺省=收到确认)/executeTimeMs/errorCode/message |
| 状态机 | 实施方案 §11.7 + PUBLISHING（BE-CMD-02 抢占中间态）：PUBLISHED→ACKNOWLEDGED→SUCCEEDED/FAILED；PUBLISHED→SUCCEEDED/FAILED（直达）；未完成→TIMED_OUT |
| 功能边界 | 不负责设备执行和定时器运维调度（evaluator 由部署层周期调用） |

**不一致点解决**：ack.schema.json `result: SUCCESS|FAILED` vs Prisma 原注释 `SUCCEEDED|FAILED` → command_acks.result 落库线上原值 `SUCCESS|FAILED`；无 result 的收到确认记 `RECEIVED`；命令状态用 `SUCCEEDED/FAILED`（schema 注释已修正）。

## 2. ACK Handler 规则

1. 字段强制（契约字段级弱必填 → Handler 强制）：commandId/command 必填；result 仅 SUCCESS|FAILED；executeTimeMs 非负整数；违反 → INVALID_ENVELOPE 隔离；
2. 匹配校验：commandId 未知 → UNKNOWN_COMMAND 隔离；**deviceId 不一致或 command 与原命令不符 → COMMAND_MISMATCH 隔离**（防跨设备伪造回执）；
3. 前置状态（classifyAck）：未发布（CREATED/AUTHORIZED/PUBLISHING）→ INVALID_COMMAND_STATE 隔离；
4. 迁移：PUBLISHED/ACKNOWLEDGED + result → SUCCEEDED/FAILED；PUBLISHED 无 result → ACKNOWLEDGED；条件 updateMany 并发兜底（漂移则降级为事件）；
5. **迟到 ACK（TIMED_OUT/终态）：command_acks 保存为事件，状态不回改（不得把 TimedOut 静默改成功）**；
6. 幂等：receipt 键 `{deviceId}:ack:{seq}`（重复 → DUPLICATE_SKIPPED 不重复落行）+ command_acks.sourceMessageId 唯一约束兜底；
7. 审计链：每次真实处理写 audit_logs（action=command.ack，actorId=deviceId/actorRole=device，before/after 状态）+ 归档 Outbox（topicType=ack，ArchiveOutboxParams 联合类型已扩展）。

## 3. Timeout Evaluator

`evaluateCommandTimeouts({client, now})`：扫描 `status IN (AUTHORIZED/PUBLISHING/PUBLISH_FAILED/PUBLISHED/ACKNOWLEDGED) AND expiresAt <= now`（PUBLISHING 滞留兜底），逐条条件 updateMany → TIMED_OUT，仅真实迁移成功才同事务 recordAudit（command.timeout，actor=system）；幂等（终态不再扫描）。配套 migration 补 `(status, expires_at)` 索引（Expand 阶段仅加索引）。

## 4. 查询 API

- `GET /api/v1/admin/commands`（device:read）：customerId/deviceId/status(9 态枚举）/command(22 白名单）/requestTime 范围筛选 + 键集游标；Customer 角色强制租户 scope；
- `GET /api/v1/admin/commands/{commandId}`（device:read）：详情含 remarks/confirmedBy + attempts/acks 时间线；跨 Customer → 404；
- **权限决策**：DEC-012 V1 矩阵无 command:read，查询复用 device:read（全角色可读），不扩矩阵（整体替换式演进留后续决策）。

## 5. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 成功 ACK | PUBLISHED+SUCCESS → SUCCEEDED，ack 落行，command.ack 审计 + 归档 Outbox | ✅ |
| 失败 ACK | PUBLISHED+FAILED（errorCode/message）→ FAILED | ✅ |
| 收到确认 | 无 result → ACKNOWLEDGED（RECEIVED）；结果后至 → SUCCEEDED；重复确认 event-only | ✅ |
| 重复 ACK | 同 receipt 键 → DUPLICATE_SKIPPED（ack/审计恰 1 条）；终态后新 ACK → 事件保存状态不变 | ✅ |
| 冲突 ACK | command 不符 → COMMAND_MISMATCH 隔离，状态不变不落 ack；deviceId 不匹配同理 | ✅ |
| 未知 ACK | commandId 未知 → UNKNOWN_COMMAND 隔离 | ✅ |
| 迟到 ACK | TIMED_OUT+SUCCESS → 事件保存、状态保持 TIMED_OUT | ✅ |
| 前置状态无效 | AUTHORIZED 收 ACK → INVALID_COMMAND_STATE 隔离 | ✅ |
| Timeout | 4 个过期未完成态 → TIMED_OUT + 恰 4 条 system 审计；未过期/终态不动；二次评估幂等 | ✅ |
| 查询 | 筛选/分页去重/租户隔离/跨 Customer 404/未认证 401；详情 attempts/acks 时间线 | ✅ |

测试：`vitest run apps/ingestion-worker/test/signals-ack.test.ts`（11 项）、`apps/cloud-api/test/admin-command-query.test.ts`（4 项）、`packages/domain/test/command.test.ts`（16 项，状态机 6 项）；契约 `node --import tsx --test contracts/rest/admin-command-api.test.ts`（5 项）。

## 6. 未决风险

- Timeout evaluator 逐条事务（V1 规模可接受；大规模积压需批量化，留待性能决策）；
- 查询权限复用 device:read（DEC-012 矩阵无 command:read；若需独立命令读权限点需矩阵整体演进决策）；
- ACK 无 result 的 ACKNOWLEDGED 中间态依赖设备端是否实现"两段式回执"（契约字段级弱必填所容许；若设备恒带 result 则该路径退化为直达终态）；
- evaluator 已由独立 Lambda + EventBridge 每分钟调度，配置失败重试、DLQ 与 CloudWatch 告警；目标 AWS 时序仍需部署回执验收。
