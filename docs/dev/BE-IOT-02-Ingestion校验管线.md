# BE-IOT-02 Ingestion 通用校验管线

任务来源：`docs/管理后台开发任务清单.md` L451-459（BE-IOT-02，依赖 BE-IOT-01 / AUTH-03 / CT-03 / DB-02）。

## 范围

批量 SQS 消费 + 通用校验管线：Envelope 结构 → 身份/台账解析 → DEC-013 `audit.hash` 复算 → 兼容格式规范化 → CT-03 正式 Schema（含字段范围）→ 时钟偏差；解析 device/customer context；按错误类型区分 retry / Quarantine。具体消息业务（Heartbeat 落库等）归 BE-IOT-04 等后续任务，本任务提供 `onValidated` 扩展点。

## 实现

模块：`apps/ingestion-worker/src/ingest/`

| 文件 | 职责 |
| --- | --- |
| [errors.ts](../apps/ingestion-worker/src/ingest/errors.ts) | `IngestError`：`classification` ∈ TRANSIENT / QUARANTINE；DEC-013 Hash 不匹配使用 `AUDIT_HASH_MISMATCH`，兼容格式冲突/过期使用 `SCHEMA_VIOLATION`；`errorPath` 稳定点分路径 |
| [envelope.ts](../apps/ingestion-worker/src/ingest/envelope.ts) | Envelope 解析（契约：BE-IOT-01 `contracts/iot/ingress-envelope.schema.json`）：JSON 解析 + 五个 iot\* 字段校验（Topic 白名单正则、iotType ↔ Topic 一致、iotReceivedAt 非负整数毫秒、iotPrincipal 非空），剥离 iot\* 前缀得原始 Payload |
| [identity.ts](../apps/ingestion-worker/src/ingest/identity.ts) | 身份/台账解析：iotPrincipal（证书 ARN）→ `device_certificates` 台账（未登记 → UNKNOWN_DEVICE；非 ACTIVE/已撤销 → IDENTITY_VIOLATION）；证书绑定设备 ≠ Topic 设备 → IDENTITY_VIOLATION（跨设备伪装防护）；customerId 只取设备台账，不取 Payload 自报值 |
| [schema.ts](../apps/ingestion-worker/src/ingest/schema.ts) | CT-03 零依赖校验器按 `<iotType>.schema.json` 校验 Payload（enum/minimum/maximum 等字段范围由 Schema 覆盖），首个错误路径入 Quarantine；时钟偏差：meta.ts 与 iotReceivedAt 偏差超阈值（缺省 300s）→ CLOCK_SKEW |
| [pipeline.ts](../apps/ingestion-worker/src/ingest/pipeline.ts) | 框架无关处理链 `validateRecord`；Audited Topic 先按消息原文复算 `SHA-256(RFC8785({meta,data}))`，再执行 90 天旧格式转换，输出正式结构 `ValidatedMessage` |
| [handler.ts](../apps/ingestion-worker/src/ingest/handler.ts) | SQS 批量 Handler：QUARANTINE → 写 Quarantine（原文 + errorType + errorPath + Topic 上下文）后视为已处理；TRANSIENT/未知异常 → `batchItemFailures` 部分失败重试 |

导出：`apps/ingestion-worker/src/ingest/index.ts`，并由 `apps/ingestion-worker/src/index.ts` 汇出。

## 错误路由语义

- **Quarantine（不重试）**：契约/身份/时钟类坏消息，保存原文与错误元数据供排查，不阻塞批次、不进重试（避免 poison message 导致整批重复）。
- **Retry（batchItemFailures）**：DB/AWS 瞬时错误与未知异常，由 SQS 重试，耗尽后进入 Ingress DLQ（BE-IOT-01 基础设施）。
- 敏感字段控制：Quarantine 记录仅含原文与错误元数据；Handler 不输出 Payload 日志。

## 验收证据

测试：[ingest-pipeline.test.ts](../apps/ingestion-worker/test/ingest-pipeline.test.ts)（PGlite 真实 PostgreSQL + 全量 migration + 真实 CT-03 Schema），10 项：

1. 合法批次全部继续处理；device/customer context 取自台账而非 Payload；
2. 单条坏消息（非法 JSON）不导致整批重复：坏消息进 Quarantine，其余照常处理，`batchItemFailures` 为空；
3. Schema 违规（enum 越界）进 Quarantine，`errorPath` 含 `deviceStatus`，附 Topic 上下文；
4. 身份违规进 Quarantine：未知证书 UNKNOWN_DEVICE / 非 ACTIVE 证书 IDENTITY_VIOLATION / Topic 设备与证书绑定不一致 IDENTITY_VIOLATION（路径 `iotDeviceId`）；
5. 时钟偏差 3600s > 300s 阈值 → CLOCK_SKEW（路径 `meta.ts`）；
6. 瞬时错误（业务分发抛非 IngestError）：仅该条进 `batchItemFailures`，其余正常处理；
7. Envelope 结构违规：iotPrincipal 缺失 / Topic 与 iotType 不一致 → INVALID_ENVELOPE。
8. 兼容期内嵌套 Heartbeat 与 `DISCHARING` 转换为正式扁平字段和 `DISCHARGING`；
9. 兼容截止边界起旧格式进入 Quarantine；
10. Audited Topic Hash 可复算，不匹配以 `AUDIT_HASH_MISMATCH / audit.hash` 隔离。

命令与结果：

```text
pnpm vitest run apps/ingestion-worker   → Test Files 4 passed, Tests 15 passed（含既有 8 项）
pnpm verify                              → EXIT=0（lint/format/typecheck/test 43 文件 345 项/build/boundaries/schemas/migrations/secrets）
```

## 未决风险

- `defaultSchemasDir` 依赖 monorepo 源码直引（`createRequire` 解析 `@fdp/contracts/mqtt/validator.mjs`）；容器化部署（INFRA 系列）需确保 contracts 的 schemas 随包携带，部署任务落地时验证。
- QuarantineSink 当前为端口接口，实际 SQS 实现随部署接线（BE-IOT-04 / INFRA 任务）。
- TRANSIENT 分类目前由"非 IngestError 异常"兜底触发；如需将特定 AWS SDK 错误显式映射为 TRANSIENT，可在后续任务补充。
