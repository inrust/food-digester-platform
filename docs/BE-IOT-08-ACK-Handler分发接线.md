# BE-IOT-08 ACK Handler（分发接线）

ACK 业务逻辑已在 BE-CMD-03 落地于 [signals/ack.ts](../apps/ingestion-worker/src/signals/ack.ts)。本任务补齐**生产接线缺口**：校验管线输出的 `onValidated` 扩展点此前缺省 no-op，ACK（及全部上行信号）不会进入任何 Handler。

## 1. 范围与变更

| 项 | 说明 |
|---|---|
| 任务 | BE-IOT-08（P1 / IoT 后端），依赖 BE-IOT-03（receipt 幂等/管线）、BE-CMD-03（classifyAck 状态机 + ACK Handler 实现） |
| 新增 | [ingest/dispatcher.ts](../apps/ingestion-worker/src/ingest/dispatcher.ts)：`createBusinessDispatcher`——按 iotType 封闭路由表分发到 heartbeat/telemetry/report/alarm/event/tamper/ack/media 八个 Handler（均实现 `handled` 语义，首个 `handled=true` 胜出） |
| 接线 | `createIngestionHandler({ ..., onValidated: createBusinessDispatcher(deps) })`；[ingest/handler.ts](../apps/ingestion-worker/src/ingest/handler.ts) 扩展点注释更新；ingest/index.ts 导出 |
| 错误类型 | `IngestErrorType` 保留 `NO_HANDLER` 作为未知类型兜底；media 已注册 Media Handler，业务拒绝使用 `MEDIA_METADATA_REJECTED` / `MEDIA_SESSION_EXPIRED` 稳定隔离原因 |
| 工程修复 | eslint.config.mjs 忽略 `**/cdk.out/**`（CDK 构建产物，与 .gitignore 对齐） |

## 2. 规则确认（ACK Handler 既有语义，端到端复验）

- ACK 按 commandId 更新命令结果、执行时长（executeTimeMs）与错误（errorCode/message）；无 result → ACKNOWLEDGED（RECEIVED 落库）；
- 未知 commandId → UNKNOWN_COMMAND 隔离；跨设备回执 / command 不符 → COMMAND_MISMATCH 隔离；CREATED/AUTHORIZED/PUBLISHING 收到 ACK → INVALID_COMMAND_STATE 隔离（设备不可能持有）；
- 迟到 ACK（TIMED_OUT/终态）：command_acks 保存为事件，状态不回改；
- 对 PUBLISHED 命令同时以 ACK 事件时间和服务端处理时间校验 `expiresAt`；任一时间达到边界即仅保存事件。条件更新再次要求 `expiresAt > cutoff`，与 timeout evaluator 并发时也禁止迁移为成功；
- 幂等：receipt 键 `{deviceId}:ack:{seq}` + `command_acks.sourceMessageId` 唯一约束双保险；
- DEC-015 隔离：`objectType` + 关联 ID 判别——COMMAND 与 OTA_TARGET 字段禁止混带；OTA 分支只更新 ota_targets + ota_status_history + DEC-016 归档，不回改 Command；
- 审计链：command.ack / ota.status.ack（actor=设备）+ 归档 Outbox。

## 3. 验收基准与证据（Vitest + PGlite）

| 验收基准 | 测试（[ack-dispatch.test.ts](../apps/ingestion-worker/test/ack-dispatch.test.ts)，全链路 SQS→管线→分发器→Handler） | 结果 |
|---|---|---|
| ACK 按 commandId 更新结果/时长 | SQS ack 记录 → 命令 PUBLISHED→SUCCEEDED，command_acks 落 executeTimeMs=420/result=SUCCESS，无 batchItemFailures | ✅ |
| 重复 ACK 幂等 | 全链路同 seq 同 payload 重放 → command_acks 仅 1 行、隔离区无记录 | ✅ |
| 冲突/未知进确定异常路径 | UNKNOWN_COMMAND / COMMAND_MISMATCH → Quarantine、不重试、两条命令均不被误更新、无误落 ack | ✅ |
| 不得误更新其他命令或 OTA Target | OTA_TARGET ACK 仅迁移 target NOTIFIED→DOWNLOADING + 历史 1 行，command 状态/ack 不变；COMMAND 混入 otaTargetId → 隔离 | ✅ |
| 过期 ACK | `signals-ack.test.ts` 覆盖 TIMED_OUT 后回执、PUBLISHED 但服务端当前时间已过期，以及 ACK 恰在到期边界与 timeout evaluator 并发；均保存事件且绝不迁移为 SUCCEEDED | ✅ |
| 路由表/异常兜底 | heartbeat 经分发器落 device_latest_state（connectivity ONLINE）；media 经 BE-IOT-03 receipt 调用 BE-MED-01 共用核心 | ✅ |

当前证据命令：`pnpm vitest run apps/ingestion-worker/test/ack-dispatch.test.ts apps/ingestion-worker/test/signals-ack.test.ts` 与 `pnpm verify`。精确结果见 [BE-IOT-01 至 BE-IOT-09 全面复盘检查报告](audit/BE-IOT-01至BE-IOT-09全面复盘检查报告-2026-09-07.md)。

## 4. 未决风险

- **双实现语义漂移**：cloud-api 侧 `handleOtaAck`（BE-OTA-03，返回值式）与 ingestion 侧 `handleOtaTargetAck`（隔离式）并存——同状态重放是否写历史、归档事件 shape 不同。生产链路以本分发器（ingestion 版）为准；cloud-api 版供非 ingest 消费者使用，如需唯一实现应另立任务收敛。
- **media 上行路由**：部署层第 8 条 IoT Rule 与其他上行共用 Ingress；ingestion-worker 的 Media Handler 复用 `@fdp/media` 注册核心，receipt、会话完成、MediaObject 与审计同事务提交。
- **运行时入口**：Lambda/SQS 入口组装（handler = createIngestionHandler + dispatcher）由部署层接线（与既有任务口径一致）；timeout evaluator 周期调度同样属部署层。
