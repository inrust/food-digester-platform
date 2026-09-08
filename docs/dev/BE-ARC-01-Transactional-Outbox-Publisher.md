# BE-ARC-01 Transactional Outbox Publisher

任务来源：[管理后台开发任务清单](../管理后台开发任务清单.md) 中 `BE-ARC-01`；依赖 DB-02、BE-IOT-03、IAC-01、DEC-016。

## 范围

Archive Publisher 只领取未发布的 `ARCHIVE` outbox event，批量发送 Archive SQS，并原子记录发布时间、失败重试和租约。不做人工重试和队列运维。设备 Notification 由独立 Publisher、Lambda 和 EventBridge 调度处理，二者不共享事件过滤、Sender 或 IAM 发布权限。

## 实现

| 文件 | 职责 |
| --- | --- |
| [publisher.ts](../../apps/ingestion-worker/src/outbox/publisher.ts) | `createOutboxPublisher` 固定 `eventTypes=['ARCHIVE']` 并构造稳定 Archive 消息 |
| [notification-publisher.ts](../../apps/ingestion-worker/src/outbox/notification-publisher.ts) | CT-04 Notification 的独立事件过滤、Payload 校验和 MQTT 发布 |
| [leased-publisher.ts](../../apps/ingestion-worker/src/outbox/leased-publisher.ts) | 通用租约领取、成功/失败条件更新及批内失败隔离 |
| [outbox-publisher-entry.ts](../../apps/ingestion-worker/src/runtime/outbox-publisher-entry.ts) | Archive 生产入口，仅依赖 Archive SQS Sender |
| [notification-publisher-entry.ts](../../apps/ingestion-worker/src/runtime/notification-publisher-entry.ts) | Notification 生产入口，仅依赖 IoT Data Publisher |
| [sqs-archive-sender.ts](../../packages/aws-clients/src/sqs-archive-sender.ts) | Archive SQS `SendMessage`；FIFO 时以 eventId 去重、aggregateId 分组 |
| [outbox lease migration](../../packages/database/prisma/migrations/20260908100000_outbox_publisher_leases/migration.sql) | `lease_token`、`lease_until`、`last_attempt_at` 及领取索引 |

## 并发与恢复语义

- 候选查询只返回状态为 `PENDING`、重试未耗尽且无租约或租约已到期的目标事件。
- 每行以 `(id, status, retryCount, lease availability)` 条件更新写入唯一 `leaseToken`；多个实例即使读到同一候选，也只有一个实例能取得所有权并发送。
- 发送失败只允许租约所有者清除租约、原子 `retryCount increment` 并记录截断后的 `lastError`；达到上限转为 `FAILED`。
- 成功只允许租约所有者写入 `PUBLISHED/publishedAt` 并清除租约。进程在发送前崩溃时租约到期后恢复；发送后、标记前崩溃仍保持 at-least-once，由稳定 `eventId` 和 Archive Worker 的幂等对象键收敛。
- 单条失败不会回滚已提交业务记录，也不会阻塞同批其他事件。

## 验收证据

[outbox-publisher.test.ts](../../apps/ingestion-worker/test/outbox-publisher.test.ts) 使用 PGlite 真 PostgreSQL 语义验证职责隔离、双 Publisher 并发、未到期租约排他、过期租约恢复、发送前后中断、稳定 eventId、原子重试、终态失败和单条失败隔离。

当前本地全仓证据命令为 `pnpm verify`；精确测试快照、问题闭环和目标环境边界见 [BE-ARC/RPL/ESG 全面复盘检查报告](../audit/BE-ARC-01-02-BE-RPL-01-BE-ESG-01全面复盘检查报告-2026-09-07.md)。目标 AWS 回执必须通过独立数据处理证据 Gate，本地测试或 CDK synth 不替代云端验收。

## 运维边界

- EventBridge 调度、Archive/Notification Lambda 和最小 IAM 已进入 CDK 生产组合根。
- FAILED 告警与人工重放流程仍属于运维任务，不在本交付中自动执行。
- 租约缺省五分钟，长于当前 Publisher Lambda 超时；修改 Lambda 超时必须同步评估租约时长。
