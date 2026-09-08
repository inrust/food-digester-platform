# BE-ESG-01 小时/日聚合 Worker

任务来源：[管理后台开发任务清单](../管理后台开发任务清单.md) 中 `BE-ESG-01`；依赖 BE-IOT-05、DB-02。

## 范围

按 event time、device、历史 Customer/Site 维度重算 `telemetry_hourly`、`telemetry_daily` 和 `esg_daily_summary`，持久化完整率、缺失数与计算版本。乱序和迟到记录在回看窗口内重算收敛。不承担正式碳核证，也不重新定义设备侧指标。

## 实现

| 文件 | 职责 |
| --- | --- |
| [worker.ts](../../apps/summary-worker/src/aggregation/worker.ts) | event-time 分桶、维度分组、完整率/缺失数、确定性 rollup 与事务内原子 upsert |
| [summary-entry.ts](../../apps/summary-worker/src/runtime/summary-entry.ts) | EventBridge 入口，根据 UTC 当前时刻和回看窗口执行重算 |
| [schema.prisma](../../packages/database/prisma/schema.prisma) | receipt 的 occurredAt/customerId/siteId 快照及三张聚合表的历史维度键 |
| [correctness migration](../../packages/database/prisma/migrations/20260907143000_archive_replay_esg_correctness/migration.sql) | event time、历史维度、缺失数和唯一键迁移 |

## 计算与一致性

- `ingestion_receipts.occurredAt` 在首次接收时保存设备消息 event time；旧记录仅在迁移时以 `receivedAt` 回填。Customer/Site 同时保存不可变历史快照，设备后续转移不会改写旧聚合归属。
- Hourly 以 `deviceId + customerId + siteId + UTC hour(occurredAt)` 分桶；完整率为去重 seq 数除以闭区间期望数，缺失数独立持久化。
- Daily 按相同历史维度汇总 hourly；数值指标用 count 加权平均、min-of-min、max-of-max。ESG daily 对报告字段求和、完整率求均值、缺失数求和并关联 ACTIVE 计算版本。
- 每个逻辑键在数据库事务与 advisory lock 内执行 create/update，避免并发重算产生重复或丢更新。排序和统一取整保证固定输入得到固定输出。
- Summary Lambda 与每小时 EventBridge 调度已进入生产组合根，当前回看窗口由 `SUMMARY_LOOKBACK_HOURS` 配置。

## 验收证据

[aggregation-worker.test.ts](../../apps/summary-worker/test/aggregation-worker.test.ts) 使用 PGlite 覆盖固定输出、重复执行、迟到收敛、event time 跨桶、历史 Customer/Site、缺失数、并发重算和计算版本幂等。

当前本地全仓证据命令为 `pnpm verify`；精确测试快照、问题闭环和目标环境边界见 [BE-ARC/RPL/ESG 全面复盘检查报告](../audit/BE-ARC-01-02-BE-RPL-01-BE-ESG-01全面复盘检查报告-2026-09-07.md)。EventBridge 实际触发、目标 PostgreSQL 迁移和聚合表结果必须由目标 AWS 结构化回执证明。

## 运维边界

- 当前按配置的回看窗口重算，不维护无限期增量游标；窗口外迟到数据需受控扩大窗口补算。
- 迁移必须先在目标环境演练、备份并观察锁表时间，本地 PGlite 通过不等同于生产 PostgreSQL 验收。
