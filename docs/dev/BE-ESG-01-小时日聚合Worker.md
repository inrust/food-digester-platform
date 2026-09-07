# BE-ESG-01 小时/日聚合 Worker

> 任务规格：`docs/管理后台开发任务清单.md` L551-559。优先级 P1，依赖 BE-IOT-05、DB-02。

## 范围与功能边界

- 按窗口重算三张聚合表：`telemetry_hourly`（完整率补齐）、`telemetry_daily`（rollup）、`esg_daily_summary`（ESG 日汇总）。
- 保存计算方法版本（`esg_calculation_versions`，ensure get-or-create ACTIVE 行），ESG 日汇总写入 `calculationVersionId`。
- 乱序/迟到记录可在允许窗口内重算收敛；所有写入按唯一键 findFirst→update/else create，upsert 幂等。
- 边界：不承担正式碳核证，不定义设备侧原始指标；Site 维度未建模（表结构仅 device/customer）。

## 实现

| 文件 | 说明 |
|---|---|
| `apps/summary-worker/src/aggregation/worker.ts` | `createAggregationWorker({client}).recomputeWindow({from,to})` |
| `apps/ingestion-worker/src/aggregation/index.ts` | 导出入口 |
| `apps/ingestion-worker/src/index.ts` | 汇出 aggregation 模块 |
| `apps/ingestion-worker/test/aggregation-worker.test.ts` | Fixture 验收测试（PGlite 真实 PostgreSQL） |

### 计算口径（计算版本 `aggregator@1.0.0`，formula 落库）

1. **telemetry_hourly 完整率补齐**：窗口内 `topicType='telemetry'` 的 receipt 按 `deviceId + hourFloor(receivedAt)` 分桶；完整率 = 去重已收 seq 数 / `(max(seq) - min(seq) + 1)`（百分比保留 2 位），缺失数钳制 ≥ 0；按 `(deviceId, bucketStart)` updateMany 回写 `completenessPct`。
2. **telemetry_daily**：窗口内 hourly 行按 `deviceId + utcDay(bucketStart)` 分组 rollup——`sampleCount` 求和；metrics 按 count 加权 avg、min-of-min、max-of-max（键排序 + 行按 bucketStart 排序保证确定性）；完整率取当日全部 receipt 的同口径计算。
3. **esg_daily_summary**：窗口内 `esg_reports` 按 `deviceId + utcDay(periodStartTime)` 分组——投料/出料/减量/能耗/碳减排求和、报告完整率均值（round2）、缺失数求和，写入 `calculationVersionId`。

确定性保障：分组键排序遍历、指标键排序、求和顺序固定（行按时间排序）、round2 统一取整 → 固定输入必产生固定输出。

### Prisma Decimal 归一

Decimal 列（报告重量/能耗等）经 Prisma 返回为 Decimal 对象而非 number，`asNumber` 统一经 `toNumber()` 归一后再参与求和/均值，避免被误判为非数值而漏计。

## 验收证据

`pnpm vitest run apps/ingestion-worker/test/aggregation-worker.test.ts` — 4 项全部通过：

1. **固定输入产生确定输出**：seq `{1,2,3,5,6,9,10}` → hourly 完整率 70.00%；当日 `{...,11,12}` → daily 75.00%；加权 avg（`chamberTempC` 56、`powerKw` 2.6）、min/max 合并；ESG 求和（31/24/7/30/14）、完整率均值 85、缺失 3、`calculationVersionId` 关联 ACTIVE 版本。
2. **重复执行结果不变**：同窗口二次运行后 hourly/daily/esg 三表快照 deepEqual；行数不增（upsert 覆盖同键）。
3. **乱序迟到收敛**：首跑 seq `{1,2,4}` → 75%；补到 seq 3 与迟到 report 后重算同窗口 → 100%、ESG 求和更新。
4. **计算版本幂等**：重复 ensure 不产生重复版本行，formula 内容正确。

全量回归：`pnpm vitest run apps/ingestion-worker`（13 文件 63 项通过）；`pnpm verify` 全链退出 0。

## 未决风险

- **receipt 按 receivedAt 归桶（近似）**：`ingestion_receipts` 表无 event time 列，小时/日完整率按云端接收时间归桶；若设备长时间离线后批量补报，完整率会记入补报到达的桶而非事件发生桶。如需严格 event time 口径，需在 receipt 增加 `occurredAt` 列（Schema 变更，另起任务）。
- **每日全量窗口重算**：当前按调用方给定窗口全量重算，未做增量游标；窗口内数据量大时由调用方控制窗口粒度（如每小时触发重算当日）。
- **调度接入**：Worker 仅暴露 `recomputeWindow`，定时触发（EventBridge Scheduler）属 IAC 范畴，未在本任务实现。
