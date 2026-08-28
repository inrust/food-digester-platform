# BE-ARC-02 S3 Archive Worker 与 Manifest

任务来源：`docs/管理后台开发任务清单.md` L531-539（BE-ARC-02，依赖 BE-ARC-01 / DEC-005）。

## 范围

把 Archive SQS 记录按 topic/customer/小时合并为 NDJSON/GZIP，使用规定前缀写 S3，生成 Manifest。不配置生命周期、Object Lock、长期归档或 Athena 运维。

## 实现

| 文件 | 职责 |
| --- | --- |
| [worker.ts](../apps/ingestion-worker/src/archive/worker.ts) | `createArchiveWorker({bucket, store, workerVersion, now})` → `archiveBatch(messages)`：过滤 → 批内 eventId 去重 → topic×customer×小时分组 → NDJSON/GZIP 写入 + Manifest 旁挂 |
| [s3-archive-store.ts](../packages/aws-clients/src/s3-archive-store.ts) | `createS3ArchiveObjectStore`：PutObject 端口实现（AWS 适配器） |
| [archive-manifest.schema.json](../contracts/archive/archive-manifest.schema.json) | Manifest Schema（封闭结构；CT-03 校验器兼容关键字子集）+ fixtures + node --test 契约测试 |

## 关键设计

- **规定前缀**（AWS云端运维任务清单 §归档）：`raw/topic_type={type}/customer_id={customerId}/year={yyyy}/month={mm}/day={dd}/hour={hh}/part-{hash16}.json.gz`；Manifest 旁挂同前缀 `part-{hash16}.manifest.json`。
- **归档范围**：Telemetry/Report/Alarm/Event/Tamper 必须归档；ACK/License/OTA 可选（V1 归档）；**Heartbeat 不归档**；**Media 跳过**（文件走独立 Bucket，DEC-005）。
- **行格式**：每行 = `{eventId, ...归档载荷}`（归档载荷内嵌原始上行 Payload，解压后每行是原始可验证 JSON；audit.hash 随行保留，DEC-002）。
- **重复事件不产生逻辑重复**：批内按 eventId 去重；part Key 由去重后 eventId 集合 SHA-256 前 16 位派生 + 行按 occurredAt/eventId 稳定排序 + GZIP 无时间戳（zlib MTIME=0）→ 同批次重跑产生**相同 Key、相同字节**，覆盖写不生新对象。
- **Manifest 字段**：manifestVersion、bucket/key、topicType/customerId、windowStartUtc（整点）、recordCount、occurredAt 时间范围、seq 序号范围（全缺为 null）、**sha256（GZIP 字节，可复算）**、schemaVersions、workerVersion、eventIds（Replay 溯源）、createdAt。

## 验收证据

- Worker 集成测试：[archive-worker.test.ts](../apps/ingestion-worker/test/archive-worker.test.ts)（内存 ObjectStore），7 项：
  1. 五类必须归档 + ack 归档；heartbeat/media 各跳过 1；
  2. 规定前缀正则断言（customerId 正确）+ manifestKey 派生；
  3. 解压逐行 JSON 解析，原始 Payload deepEqual 内嵌、audit.hash 保留；
  4. Manifest 全字段（时间/序号范围、schemaVersions、workerVersion、eventIds 稳定排序）；
  5. 对象 Hash 可复算（重算存储字节 == manifest.sha256）；
  6. 批内重复投递去重一行；同批次重跑同 Key 同字节同 Hash，逻辑仍一个对象；
  7. 跨 customer/小时/topic 分组为四个独立对象。
- 契约测试：`contracts/archive/archive-manifest.test.mjs`（2 合法 + 5 非法 fixtures）。

命令与结果：

```text
pnpm vitest run apps/ingestion-worker/test/archive-worker.test.ts   → 7 passed
pnpm --filter @fdp/contracts test                                    → pass 151, fail 0
pnpm verify                                                          → EXIT=0（lint/format/typecheck/test 50 文件 386 项/build/boundaries/schemas/migrations/secrets）
```

## 未决风险

- Worker 输入为 ArchiveEventMessage 批次（SQS 轮询/Lambda 触发接线归 IAC/部署任务）；发送方失败语义由 BE-ARC-01 Publisher 承担。
- 跨批次同分组产生多个 part 对象（下游按 eventId/Manifest 溯源去重；不做对象合并，边界外）。
- seq 取自原始 Payload meta.seq；ACK/License/OTA 下行 Schema 未冻结，按可选归档透传。
