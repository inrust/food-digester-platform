# BE-ARC-02 S3 Archive Worker 与 Manifest

任务来源：`docs/管理后台开发任务清单.md` L531-539（BE-ARC-02，依赖 BE-ARC-01 / DEC-005）。

## 范围

把 Archive SQS 记录按来源/customer/小时合并为 NDJSON/GZIP，依据 DEC-016 分流到独立 S3 前缀并生成 Manifest。不配置生命周期、Object Lock、长期归档或 Athena 运维。

## 实现

| 文件 | 职责 |
| --- | --- |
| [worker.ts](../../apps/ingestion-worker/src/archive/worker.ts) | `createArchiveWorker({bucket, store, workerVersion, now})` → `archiveBatch(messages)`：判别来源 → 批内 eventId 去重 → 来源×customer×小时分组 → NDJSON/GZIP 写入 + Manifest 旁挂 |
| [s3-archive-store.ts](../../packages/aws-clients/src/s3-archive-store.ts) | `createS3ArchiveObjectStore`：PutObject 端口实现（AWS 适配器） |
| [archive-source-policy.json](../../contracts/archive/archive-source-policy.json) | DEC-016 三类来源、Envelope、前缀和生产者冻结策略 |
| [archive-manifest.schema.json](../../contracts/archive/archive-manifest.schema.json) | MQTT 原文 Manifest Schema（封闭结构；CT-03 校验器兼容关键字子集）+ fixtures + node --test 契约测试 |

## 关键设计

- **独立前缀**：MQTT 原文使用 `raw/topic_type={type}/...`；License 领域事件使用 `domain/entity_type=license/...`；OTA 发布/结果使用 `operations/operation_type=ota/record_type={publication|result}/...`；Manifest 旁挂同前缀。
- **归档范围**：Telemetry/Report/Alarm/Event/Tamper 必须归档；ACK 可选；License 状态变化和 OTA 发布/结果按 DEC-016 独立归档；**Heartbeat 不归档**；**Media 跳过**（文件走独立 Bucket，DEC-005）。
- **行格式**：每行 = `{eventId, ...归档载荷}`（归档载荷内嵌原始上行 Payload，解压后每行是原始可验证 JSON；audit.hash 随行保留，DEC-002）。
- **重复事件不产生逻辑重复**：批内按 eventId 去重；part Key 由去重后 eventId 集合 SHA-256 前 16 位派生 + 行按 occurredAt/eventId 稳定排序 + GZIP 无时间戳（zlib MTIME=0）→ 同批次重跑产生**相同 Key、相同字节**，覆盖写不生新对象。
- **Manifest 字段**：所有来源记录 archiveClass/sourceType、bucket/key、customerId、时间范围、记录数、Hash、Worker 版本与 eventIds；MQTT 原文额外记录 topicType、seq 范围和 Schema 版本。

## 验收证据

- Worker 集成测试：[archive-worker.test.ts](../../apps/ingestion-worker/test/archive-worker.test.ts)（内存 ObjectStore），10 项：
  1. 五类必须归档 + ack 归档；heartbeat/media 各跳过 1；
  2. 规定前缀正则断言（customerId 正确）+ manifestKey 派生；
  3. 解压逐行 JSON 解析，原始 Payload deepEqual 内嵌、audit.hash 保留；
  4. Manifest 全字段（时间/序号范围、schemaVersions、workerVersion、eventIds 稳定排序）；
  5. 对象 Hash 可复算（重算存储字节 == manifest.sha256）；
  6. 批内重复投递去重一行；同批次重跑同 Key 同字节同 Hash，逻辑仍一个对象；
  7. 跨 customer/小时/topic 分组为四个独立对象。
  8. License/OTA 使用 `domain/`、`operations/` 独立前缀；
  9. `topicType=license|ota` 的 MQTT 原文伪装被拒绝。
  10. Envelope 版本错误或跨类型字段混用时失败关闭。
- 契约测试：`contracts/archive/archive-manifest.test.mjs`（2 合法 + 5 非法 fixtures）。

命令与结果：

```text
pnpm vitest run apps/ingestion-worker/test/archive-worker.test.ts   → 10 passed
pnpm --filter @fdp/contracts test                                    → pass 246, fail 0
pnpm verify                                                          → EXIT=0（lint/format/typecheck 19/19；实现测试 83 文件 676 项；契约 246 项；脚本 53 项；build 13/13；boundaries/schemas/migrations/secrets）
```

## 未决风险

- Worker 输入为 ArchiveEventMessage 批次（SQS 轮询/Lambda 触发接线归 IAC/部署任务）；发送方失败语义由 BE-ARC-01 Publisher 承担。
- 跨批次同分组产生多个 part 对象（下游按 eventId/Manifest 溯源去重；不做对象合并，边界外）。
- seq 仅取自 MQTT 原始 Payload `meta.seq`；License/OTA 不参与 MQTT Replay，OTA `PUBLICATION` 记录待 BE-OTA-03 发布器实现时写入。
