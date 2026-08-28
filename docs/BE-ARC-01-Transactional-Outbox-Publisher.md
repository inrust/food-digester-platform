# BE-ARC-01 Transactional Outbox Publisher

任务来源：`docs/管理后台开发任务清单.md` L521-529（BE-ARC-01，依赖 DB-02 / BE-IOT-03 / IAC-01）。

## 范围

读取未发布 outbox event，批量发送 Archive SQS，原子记录发布时间和重试信息。不做人工重试和队列运维。

## 实现

| 文件 | 职责 |
| --- | --- |
| [publisher.ts](../apps/ingestion-worker/src/outbox/publisher.ts) | `createOutboxPublisher({client, sender, batchSize=50, maxAttempts=8, now})`：`publishPendingBatch()` 按 createdAt 领取 PENDING 批次 → 逐条发送 → 原子标记 |
| [sqs-archive-sender.ts](../packages/aws-clients/src/sqs-archive-sender.ts) | `createSqsArchiveSender({queueUrl, client?, region?})`：SendMessage；`event_id`/`event_type` MessageAttributes；FIFO 队列自动设置 `MessageDeduplicationId=eventId`、`MessageGroupId=aggregateId` |
| migration `20260828090000_outbox_event_retry` | outbox_events 新增 `retry_count`（默认 0）、`last_error` |

## 关键设计

- **事件 ID 稳定**：发送载荷 `eventId = outbox_events.id`（uuid，创建即固定）；重复投递由下游按 eventId 去重，不产生重复归档对象记录。
- **at-least-once 语义**：
  - 发送前中断 → 事件保持 PENDING，重启后补发（不丢）；
  - 发送后、标记前中断 → 重启后重复发送，下游去重（不丢、不重复归档）。
- **原子记录**：成功 → 条件更新 `(id, status='PENDING')` → PUBLISHED + publishedAt + 清空 lastError；失败 → 同一行原子更新 retryCount+1 / lastError（截断 500 字符），达到 maxAttempts → FAILED（不再自动领取，人工处置归边界外）。
- **发布失败不影响已提交业务记录**：业务写入在 BE-IOT-03 receipt 事务早已提交；Publisher 仅逐条独立更新 outbox 行，无跨行事务，单条失败 `continue` 不阻塞批次内其他事件。

## 验收证据

测试：[outbox-publisher.test.ts](../apps/ingestion-worker/test/outbox-publisher.test.ts)（PGlite 真实 PostgreSQL + RecordingSender 含下游去重表模拟），5 项：

1. 批量发布：3 条全 PUBLISHED + publishedAt 原子记录 + eventId 稳定；第二轮 claimed=0；
2. 发送前中断：零投递、PENDING 保留，重启后补发全部（不丢）；
3. 发送后中断：投递已发生但标记未发生 → 重启重复投递 2 次，下游按 eventId 去重后归档对象恰 1 条；
4. 重试信息：retryCount 递增 + lastError 记录；maxAttempts=2 后 FAILED 且不再领取；
5. 中间单条失败：其余 2 条照常 PUBLISHED；已提交业务记录（device_events 3 行）不受影响；失败条下轮补发成功。

命令与结果：

```text
pnpm vitest run apps/ingestion-worker   → Test Files 10 passed, Tests 48 passed
pnpm verify                              → EXIT=0（lint/format/typecheck/test 49 文件 379 项/build/boundaries/schemas/migrations/secrets）
```

## 未决风险

- 领取无 SKIP LOCKED 行锁：多实例并发部署时同批可能被两个 Publisher 同时领取发送（下游去重兜底，但建议部署为单实例或后续加 `FOR UPDATE SKIP LOCKED` 认领）。
- 重试无退避策略（每轮全量重试 PENDING）；FAILED 事件无自动告警（边界外）。
- 队列 URL / 调度触发（Lambda EventBridge 或 worker 循环）归 IAC-01 部署接线。
