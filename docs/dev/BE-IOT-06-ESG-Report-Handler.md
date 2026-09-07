# BE-IOT-06 ESG Report Handler

任务来源：`docs/管理后台开发任务清单.md` L491-499（BE-IOT-06，依赖 BE-IOT-03 / CT-03）。

## 范围

保存 Cycle/Hourly/Daily Report（期间、吞吐、处理、能耗、气体、碳减排方法、完整率、缺失数）到 `esg_reports`；生成归档 outbox；保留 `audit.hash` 与计算方法版本；不宣称第三方核证。不重新定义设备端报告算法。

## 实现

模块：`apps/ingestion-worker/src/report/`

| 文件 | 职责 |
| --- | --- |
| [repository.ts](../apps/ingestion-worker/src/report/repository.ts) | `buildReportRow`：Payload data → esg_reports 列映射（processingDurationMinutes→processing_minutes 四舍五入、energyConsumptionKwh→power_consumption_kwh 等）；`findOverlappingReport`（区间相交查询）；`insertReport` |
| [handler.ts](../apps/ingestion-worker/src/report/handler.ts) | `createReportHandler`：期间语义校验 → BE-IOT-03 receipt 幂等及同设备 report advisory lock → 同事务报告行 + 恰好一个 ARCHIVE outbox |

## 关键设计

- **期间校验（Schema 之外的领域约束，QUARANTINE/INVALID_REPORT）**：
  - `periodEndTime < periodStartTime` → 拒绝（路径 `data.periodEndTime`）；
  - 同设备同类型、不同起点且区间相交 → 拒绝（路径 `data.periodStartTime`）；邻接（起点=既有终点）合法。
- **相同报告幂等**：同 seq 重放由 receipt 跳过；同期间起点的新 seq 重发由预检（overlap 同起点）→ duplicate，不覆盖、不追加归档；`unique(deviceId, reportType, periodStartTime)` + `sourceMessageId` 唯一兜底。
- **RDS 与归档一致**：归档载荷 `columns` 与 RDS 行同源（`buildReportRow`），另附 `payloadHash`、`auditHash`（DEC-002）、`attestation: 'NONE'`（不宣称第三方核证）、原始 Payload。
- **计算方法版本**：`carbonReductionMethod` 原样落列；`calculationVersionId` FK 解析归 ESG 领域任务（本任务不定义算法）。
- **customerId 约束**：esg_reports.customerId 非空；未分配客户设备的报告隔离待 Replay（同 BE-IOT-05 决策）。
- **事务内 P2002 修正**：PostgreSQL 事务内语句失败即中止（25P02），唯一冲突不得在 tx 内捕获后续写；本任务同时修正 heartbeat/telemetry repository 的同类隐患——P2002 一律回滚，由 BE-IOT-02 TRANSIENT 重试后走预检幂等路径（processWithReceipt 自身的 P2002 回读在事务外，不受影响）。

## 验收证据

测试：[report-handler.test.ts](../apps/ingestion-worker/test/report-handler.test.ts)（PGlite 真实 PostgreSQL），6 项：

1. 合法 CYCLE 报告：RDS 18 列映射逐项断言 + 恰好一个归档事件（columns 与 RDS 逐键一致、auditHash、attestation=NONE）；
2. 结束早于开始 → INVALID_REPORT 隔离，零写入；
3. 期间重叠（不同起点相交）→ INVALID_REPORT 隔离；邻接期间合法入库；
4. 相同报告幂等：同 seq DUPLICATE_SKIPPED；同起点新 seq 重放 duplicate，仍一行一个归档；
5. HOURLY/DAILY 类型各自入库；可选缺省列不落（NULL）；
6. 非 report 消息不处理（分发保护）。
7. 不同起点但期间重叠的两条 Report 并发处理：恰好一条成功，另一条确定进入 `INVALID_REPORT`，数据库和归档均只有一条。

命令与结果：

```text
pnpm vitest run apps/ingestion-worker   → Test Files 8 passed, Tests 37 passed
pnpm verify                              → EXIT=0（lint/format/typecheck/test 47 文件 367 项/build/boundaries/schemas/migrations/secrets）
```

## 未决风险

- `processingDurationMinutes` 非整数值四舍五入落 Int 列（表示层转换；如协议明确保留小数需列类型调整）。
- calculationVersionId 未解析（EsgCalculationVersion 台账关联归 ESG 领域任务）。
