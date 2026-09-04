# BE-IOT-03 幂等、序号缺口与收据模块

任务来源：`docs/管理后台开发任务清单.md` L461-469（BE-IOT-03，依赖 BE-IOT-02 / DB-01）。

## 范围

按 `deviceId+type+seq` 保存 ingestion receipt；检测序号缺口；比较同键 Payload Hash；提供重复跳过、冲突隔离与缺口状态查询。业务写入、receipt、outbox 同一事务；缺口不阻塞后续消息。不请求设备补发、不做人工缺口处置。

## 数据基座（DB-01 既有表，本任务零 migration）

- `ingestion_receipts`：`idempotency_key`（`{deviceId}:{topicType}:{seq}`，实施方案 9.2）唯一约束兜底并发；`payload_hash` 同键冲突检测；`result` ∈ PROCESSED | DUPLICATE | INVALID | SECURITY_VIOLATION。
- `ingestion_gaps`：`{deviceId, topicType, expectedSeq, receivedSeq, detectedAt, resolvedAt}`，缺失区间 = `[expectedSeq, receivedSeq-1]`。

开发中发现 DB-01 已预定义两表（初稿误建重复模型/migration，已回滚），服务层直接复用。

## 实现

模块：`apps/ingestion-worker/src/ingest/`

| 文件 | 职责 |
| --- | --- |
| [receipt.ts](../apps/ingestion-worker/src/ingest/receipt.ts) | `processWithReceipt`：单事务内 插入 receipt(result=PROCESSED) → business(tx) → outbox(tx) → 缺口检测；P2002 唯一冲突 → 回读胜出记录：同 Hash → `DUPLICATE_SKIPPED`（不再执行业务写入）；不同 Hash → 抛 `QUARANTINE/PAYLOAD_CONFLICT` 安全异常（原 receipt 不覆盖）。`hashPayload` 是服务端对规范化后完整 Payload 的幂等比较摘要；它与 DEC-013 设备提供的 `audit.hash` 职责不同 |
| [gap.ts](../apps/ingestion-worker/src/ingest/gap.ts) | `recordGapForNewReceipt`（receipt 同事务）：已知最大 seq 与新 seq 不连续 → 追加缺口（已有覆盖缺口去重）；迟到消息使区间被 receipt 全覆盖 → 置 `resolvedAt`。`gapStatus`：未解除缺口查询（missingFromSeq/missingToSeq） |
| [errors.ts](../apps/ingestion-worker/src/ingest/errors.ts) | `IngestErrorType` 新增 `PAYLOAD_CONFLICT`（经 BE-IOT-02 Handler 路由进 Quarantine 实现冲突隔离） |

导出：`apps/ingestion-worker/src/ingest/index.ts` 并经 `src/index.ts` 汇出。

## 设计决策

- **冲突隔离通道**：相同键不同 Hash 不更新原 receipt（DB-01 注释"不覆盖原记录"），安全异常经 BE-IOT-02 的 Quarantine 通道路由（原文 + PAYLOAD_CONFLICT + `meta.seq` 路径），与既有错误分类体系统一。
- **重复跳过不改写**：重复消息仅回读比较，不写 DUPLICATE 行（唯一键也不允许第二行），原 PROCESSED 记录保持。
- **缺口追加式**：检测/解除均为同事务追加与标记，任何缺口都不阻塞当前或后续消息处理。

## 验收证据

测试：[ingest-receipt.test.ts](../apps/ingestion-worker/test/ingest-receipt.test.ts)（PGlite 真实 PostgreSQL + 全量 migration），6 项：

1. 首次处理：receipt + business + outbox 同事务落库，outcome=PROCESSED；
2. 相同键相同 Hash 只处理一次：顺序重复 DUPLICATE_SKIPPED；8 并发重复恰好 1 条 receipt、business 仅 1 次、无重复业务记录；
3. 相同键不同 Hash：`IngestError` QUARANTINE/PAYLOAD_CONFLICT，原 receipt Hash 不变、冲突消息无业务记录；
4. 事务原子性：business 失败 receipt 与 outbox 全回滚；
5. 缺口：seq 5 跳序正常处理且检出缺口 [3,4]，缺口期间 seq 6 照常处理；乱序补到去重（不产生重叠缺口记录），部分填充不解除、全覆盖解除；
6. 5% 重复 + 2% 乱序模拟（200 条确定性 PRNG 流）：每个唯一 seq 恰好处理一次、200 条业务记录无重复、200 条 receipt、乱序缺口全部解除。

命令与结果：

```text
pnpm vitest run apps/ingestion-worker   → Test Files 5 passed, Tests 21 passed
pnpm verify                              → EXIT=0（lint/format/typecheck/test 44 文件 351 项/build/boundaries/schemas/migrations/secrets）
```

## 未决风险

- 不同 seq 的并发首处理在各自事务内做缺口检测，极端交错下可能漏记缺口（V1 接受：缺口为运维可观测信息，非正确性依赖；如需精确可引入 deviceId+topicType 级别 advisory lock）。
- `SECURITY_VIOLATION` result 值保留于 DB-01 枚举注释，本任务未写该状态（冲突走 Quarantine 通道）；如运维需要台账内可见的安全异常计数，后续任务可扩展。
- seq 为 Int（DB-01 表结构）：按心跳分钟级频率足够；若未来高频 telemetry 超 21 亿需迁移 BigInt。
