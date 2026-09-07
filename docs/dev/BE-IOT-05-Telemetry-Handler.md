# BE-IOT-05 Telemetry Handler

任务来源：`docs/管理后台开发任务清单.md` L481-489（BE-IOT-05，依赖 BE-IOT-03 / CT-03）。

## 范围

13 项 Telemetry 指标的聚合输入/增量摘要 + S3 归档链路 outbox；维护聚合窗口最小状态；原始 Telemetry 不长期写 RDS；耗材投影仅在 Schema 明确定义耗材字段时更新（当前未定义 → 不更新、不推算）。不定义传感器算法与 ESG 核证口径。

## 实现

模块：`apps/ingestion-worker/src/telemetry/`

| 文件 | 职责 |
| --- | --- |
| [repository.ts](../apps/ingestion-worker/src/telemetry/repository.ts) | `TELEMETRY_METRIC_KEYS`（13 项，键名与 Payload/聚合 JSON 一致）；`extractSamples`；`mergeHourlyAggregate`：telemetry_hourly 整点 UTC 窗口（unique(deviceId, bucketStart)）增量合并 metrics `{avg,min,max,count}` + sampleCount；同设备 telemetry 事务由 BE-IOT-03 advisory lock 串行化，读改写不丢增量 |
| [handler.ts](../apps/ingestion-worker/src/telemetry/handler.ts) | `createTelemetryHandler`：BE-IOT-03 receipt 幂等（键 `deviceId:telemetry:seq`）→ 同事务 ① 使用 normalized Payload 做 hourly 增量合并 ② 恰好一个 ARCHIVE outbox（原始 rawBody/rawPayload + normalized payloadHash + 原始 audit.hash，DEC-002）→ S3 归档链路 |

## 关键设计

- **字段单位/范围隔离**：13 项指标的类型与范围（如 humidityPct 0-100、重量/功率非负）由 CT-03 Schema 在 BE-IOT-02 管线把关，违规 → Quarantine（含错误路径），本 Handler 不做二次校验。
- **RDS 无原始明细**：原始 Telemetry 仅存在于归档 outbox 载荷（随 S3 归档后由分发器处置）；RDS 只有 hourly 聚合行。
- **恰好一个归档事件**：receipt 幂等键保证重复消息不追加 outbox、不重复累计聚合。
- **耗材边界（DEC-008）**：冻结后的 telemetry.schema.json 仅 13 项指标、无耗材字段 → 不写 consumable_projections；不按时间/运行次数/示例值推算百分比。
- **customerId 约束**：DB-01 telemetry_hourly.customerId 非空；未分配客户的设备遥测隔离保留原文（UNKNOWN_DEVICE/device.customerId），待分配后可 Replay 重建，不静默丢聚合。
- **completenessPct**：完整率口径依赖上报频率（未冻结），本任务不落该列。

## 验收证据

测试：[telemetry-handler.test.ts](../apps/ingestion-worker/test/telemetry-handler.test.ts)（PGlite 真实 PostgreSQL + 真实 CT-03 Schema），5 项：

1. 合法记录：hourly 聚合恰好一行（13 项指标 avg=min=max=v、count=1）+ 恰好一个 ARCHIVE 事件（载荷含原始 Payload/audit.hash/customerId）；consumableProjection 零写入；
2. 增量摘要：同窗口两条合并（avg 15/min 10/max 20/count 2，sampleCount 2），跨窗口各自成行；
3. 重复消息 DUPLICATE_SKIPPED：归档事件仍恰好一个、sampleCount 不增；
4. 端到端范围隔离：humidityPct=150 经完整管线 → Quarantine（SCHEMA_VIOLATION，路径 data.humidityPct），无聚合/归档；同批合法消息照常处理；
5. 非 telemetry 消息不处理（分发保护）。
6. 同设备同窗口并发 20 条：sampleCount=20，avg/min/max/count 精确为 10.5/1/20/20，归档事件 20 条，无丢增量。
7. DEC-013 旧字段经 normalized 参与聚合，Raw Archive 仍保存原始字段和精确 rawBody，且原始 audit.hash 可复算。

命令与结果：

```text
pnpm vitest run apps/ingestion-worker   → Test Files 7 passed, Tests 31 passed
pnpm verify                              → EXIT=0（lint/format/typecheck/test 46 文件 361 项/build/boundaries/schemas/migrations/secrets）
```

## 未决风险

- daily 聚合（telemetry_daily）未在本任务写入，归后续聚合批处理任务。
- 归档 outbox 的实际 S3 写入依赖归档分发器（Outbox 消费方），归下行/归档任务。
