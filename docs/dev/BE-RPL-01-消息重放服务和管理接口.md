# BE-RPL-01 消息重放服务和管理接口

任务来源：[管理后台开发任务清单](../管理后台开发任务清单.md) 中 `BE-RPL-01`；依赖 BE-ARC-02、BE-IOT-02、AUTH-01、DOM-03。

## 范围

按 Customer、设备、事件时间和序号范围创建 Replay Job；从 S3 原始归档读取记录并重新投入 Ingress；提供任务状态与对象、行、成功、跳过、失败统计。不包含 DLQ 人工值守和大范围任务拆分运维。

## 实现

| 文件 | 职责 |
| --- | --- |
| [service.ts](../../apps/cloud-api/src/admin/replay/service.ts) | 范围与租户校验，Job、触发 Outbox 和创建审计同事务 |
| [repository.ts](../../apps/cloud-api/src/admin/replay/repository.ts) | 键集游标列表与详情 |
| [handler.ts](../../apps/cloud-api/src/admin/replay/handler.ts) | PlatformOperator/SuperAdmin 授权的创建、列表、详情端点 |
| [trigger-publisher.ts](../../apps/ingestion-worker/src/replay/trigger-publisher.ts) | `REPLAY_JOB_REQUESTED` Outbox 到 Replay SQS |
| [worker.ts](../../apps/ingestion-worker/src/replay/worker.ts) | S3 枚举、行级过滤、Ingress 重投、租约/心跳与终态审计 |
| [replay-entry.ts](../../apps/ingestion-worker/src/runtime/replay-entry.ts) | S3 Reader、SQS Sink、当前 ACTIVE 证书 ARN 注入和 partial batch response |
| [admin-replay-api.json](../../contracts/rest/admin-replay-api.json) | 三端点、Scope、Job 与 ResultSummary 封闭契约 |

## 恢复与数据语义

- Worker 以持久化 `leaseToken/leaseUntil/lastHeartbeatAt/attemptCount` 领取 PENDING 或租约过期的 RUNNING Job；有效租约不能被抢占，长任务按批续租。
- 任务只在完整读取后写 `COMPLETED`。对象读取或行解析失败会进入 `FAILED`，并与 `replay.job.execute` 失败审计在同一事务提交；单条 Ingress 发送失败计入 `failed`，不中断其他行。
- 行内 Customer、设备、event time 和序号范围独立过滤，范围外记录不进入 Ingress。重放保留原 `meta.id/meta.seq`，由 receipt 幂等避免复制业务记录。
- 创建端点、触发 Publisher、Replay SQS/Lambda、Raw Bucket 读取和 Ingress SQS 写入均已进入生产组合根。

## 验收证据

[admin-replay.test.ts](../../apps/cloud-api/test/admin-replay.test.ts) 覆盖权限、跨 Customer、范围校验、分页与审计；[replay-worker.test.ts](../../apps/ingestion-worker/test/replay-worker.test.ts) 覆盖过滤、端到端幂等、统计、失败终态、审计原子性、租约排他/接管、心跳和对象/行失败。

当前本地全仓证据命令为 `pnpm verify`；精确测试快照、问题闭环和目标环境边界见 [BE-ARC/RPL/ESG 全面复盘检查报告](../audit/BE-ARC-01-02-BE-RPL-01-BE-ESG-01全面复盘检查报告-2026-09-07.md)。真实 API 创建、SQS 触发、S3 读取、Ingress 投递及数据库终态必须由目标 AWS 结构化回执证明。

## 运维边界

- 多月范围当前按 UTC 小时枚举前缀；V1 由管理端低频使用并通过任务范围控制。
- DLQ 人工处置和 FAILED Job 的业务审批重开流程不在本任务自动执行。
