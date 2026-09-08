# BE-ARC-02 S3 Archive Worker 与 Manifest

任务来源：[管理后台开发任务清单](../管理后台开发任务清单.md) 中 `BE-ARC-02`；依赖 BE-ARC-01、DEC-005、DEC-016。

## 范围

Archive Lambda 消费 Archive SQS，把记录按来源、Customer 和 UTC 小时合并为 NDJSON/GZIP，并依据 DEC-016 写入独立 S3 前缀和旁挂 Manifest。不配置生命周期、Object Lock、长期归档或 Athena 运维。

## 实现

| 文件 | 职责 |
| --- | --- |
| [worker.ts](../../apps/ingestion-worker/src/archive/worker.ts) | 来源判别、批内 eventId 去重、分组、稳定排序、NDJSON/GZIP 与 Manifest 生成 |
| [archive-entry.ts](../../apps/ingestion-worker/src/runtime/archive-entry.ts) | SQS partial batch response 生产入口，单条失败隔离 |
| [s3-archive-store.ts](../../packages/aws-clients/src/s3-archive-store.ts) | S3 `PutObject` 适配器 |
| [archive-source-policy.json](../../contracts/archive/archive-source-policy.json) | 三类来源、Envelope、前缀和生产者冻结策略 |
| [archive-manifest.schema.json](../../contracts/archive/archive-manifest.schema.json) | Manifest 封闭契约 |

## 关键设计

- MQTT 原文写入 `raw/`，License 领域事件写入 `domain/`，OTA 发布/结果写入 `operations/`；Heartbeat 不归档，Media 文件走独立 Bucket。
- 每行保存 `{eventId, ...归档载荷}`，原始 Payload 与 `audit.hash` 保留；Manifest 记录来源、Customer、时间范围、记录数、SHA-256、Schema/Worker 版本和 eventIds。
- part Key 由去重后的 eventId 集合派生，行稳定排序且 GZIP 不写时间戳；同一批次重投得到相同 Key、字节和 Hash，跨批次由 eventId/Manifest 溯源去重。
- Lambda 已接 Archive SQS，启用 `reportBatchItemFailures`，仅授予 Raw Bucket 写权限。

## 验收证据

[archive-worker.test.ts](../../apps/ingestion-worker/test/archive-worker.test.ts) 覆盖来源/前缀、原文可逆、Manifest、Hash、重复投递、Customer/小时分组和非法 Envelope；[archive-manifest.test.mjs](../../contracts/archive/archive-manifest.test.mjs) 覆盖合法与失败关闭契约。

当前本地全仓证据命令为 `pnpm verify`；精确测试快照、问题闭环和目标环境边界见 [BE-ARC/RPL/ESG 全面复盘检查报告](../audit/BE-ARC-01-02-BE-RPL-01-BE-ESG-01全面复盘检查报告-2026-09-07.md)。S3 对象、Manifest、重复投递和 partial failure 的目标 AWS 结果必须由结构化回执证明。

## 运维边界

- 跨批次同分组允许生成多个 part，不做对象合并。
- S3 生命周期、Object Lock、长期归档、Athena 和人工 DLQ 处置另由平台运维治理。
