# BE-DEV-05 设备控制台组合查询与活动导出 API

实现：[apps/cloud-api/src/admin/device-console](../apps/cloud-api/src/admin/device-console)（errors/service/activity/export/handler）；存储模型 `device_activity_export_jobs`（[migration 20260905230000](../packages/database/prisma/migrations/20260905230000_device_activity_export_jobs/migration.sql)）；REST 契约 [admin-device-console-api.json](../contracts/rest/admin-device-console-api.json)；验收测试 [admin-device-console.test.ts](../apps/cloud-api/test/admin-device-console.test.ts)（7 项，PGlite）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DEV-05（P1 / 管理后台后端），依赖 BE-DEV-01（deriveConnectivity）、BE-IOT-04/05/06/07（心跳/遥测/报告/事件落库）、BE-ALM-01、BE-ESG-02（esg_daily_summary + 导出模式）、DEC-009（摄像头交互语义，frozen）、DEC-010（四轴分离，frozen） |
| Schema 变更 | 新增 `device_activity_export_jobs`（冻结筛选快照 + 状态机 + 短期 URL 过期语义，复用 BE-ESG-02 导出表模式） |
| 功能边界 | 不提供实时视频流（DEC-009 冻结）；不透传 MQTT 原始消息；导出为异步 Worker（分批游标拉取 + 上限 10000 行，非数据库不限量同步查询） |

## 2. 关键设计

**路由**：`GET /devices/{id}/console`（组合查询，device:read）；`GET /devices/{id}/activities`（活动日志，device:read）；`POST /devices/{id}/activities/export`（202 入队，export:create）；`GET /activity-exports/{exportId}`（状态/短期 URL，device:read）。

**控制台数据块（全部携带可追溯来源；局部缺失不使整个响应失败）**：
- device：台账 + 四轴分字段（lifecycleStatus/operationalStatus/connectivity/licenseStatus，DEC-010 不派生 enabled）；connectivity 按 DEC-024@1.0.0 由 lastHeartbeatAt 距 generatedAt ≤ 600 秒派生（包含边界，不写回）；固件最近上报优先、回退台账；
- components：device_latest_state.sensor_status 五键（overall/temperature/humidity/weight/gas，未上报 null）；
- metrics：telemetry_hourly 最新整点桶（avg/min/max + 固定单位映射 kg/%/°C/kW/ppm/A；未上报指标 null；桶聚合增量合并 → 乱序遥测不倒退最新值）；
- network/consumables/recentAlarms（固定 5 条，倒序+决胜）/contract（ACTIVE 关联摘要，无则 null）；
- esgLast7Days：UTC 日历日向前 7 个固定日槽（升序），无聚合行日槽指标为 null；
- latestMedia：captureTime 最新非 DELETED 一条（DEC-009 仅最新一张）；无数据稳定 null，不阻塞 P1 核心查询；
- stale 语义：心跳类块 = 超连接阈值；遥测块 = 最新桶早于 generatedAt 2 小时（暂定值）。

**活动日志**：device_events（EVENT，级别固定 INFO——事件无级别字段）∪ alarms（ALARM，级别=severity）两源归并；level/kind/from/to 筛选；occurredAt 倒序 + id 决胜 + 复合键集游标；跨 Customer → 404。

**异步导出 Worker**：创建仅入队 PENDING（冻结筛选快照 + 审计 activity.export.create）；`processActivityExportJobs` 条件更新抢占 → 与列表同源查询（每源独立游标分批翻页——未消费行不推进其源游标，不丢不重；上限 10000 行）→ CSV（封闭 16 列，RFC 4180 转义）→ 注入端口存储/签名（15 分钟短期 URL）→ COMPLETED；失败 FAILED + error。URL 过期后 downloadUrl=null、urlExpired=true；读取有效 URL 审计 activity.export.download。

## 3. 验收基准与证据（vitest + PGlite，7 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 原型字段可追溯 | 四轴/部件五键/遥测（avg+单位）/网络/固件/耗材/最近 5 告警/合约摘要/7 日槽 ESG/最新 Media 全块断言 | ✅ |
| 乱序遥测不倒退 | 先插旧桶（9.9kW）再插新桶（1.5kW）→ 控制台恒读 12:00 最新桶 | ✅ |
| 部分缺失明确空值/stale | 无数据设备 200 + 各块 null/空数组 + stale=true；离线设备（存储 connectivity=ONLINE 不权威）派生 OFFLINE + stale；固件回退台账 | ✅ |
| 筛选与 CSV 一致 | level=WARNING 导出 rowCount/行序与同源 fetch 一致；level/kind/时间筛选；同刻决胜 + limit=3 翻页与全量一致（不丢不重）；非法筛选 400 | ✅ |
| 跨 Customer 失败 | console/activities/导出详情跨 Customer → 404；无 actor → 401 | ✅ |
| 导出治理 | 202 入队 + 审计；Worker COMPLETED + 短期 URL；过期 urlExpired=true 且 URL 隐藏；存储异常 → FAILED + error；Viewer 无 export:create → 403；RFC 4180 转义（逗号/引号） | ✅ |

## 4. 未决风险

- **EVENT 级别语义**：DeviceEvent 无级别字段，本任务固定 EVENT=INFO 并在 DTO 注释声明；若原型事件有级别枚举，需先扩展上行事件 Schema（另立契约变更）。
- **遥测粒度**：控制台指标取最新整点桶（BE-IOT-05 聚合粒度），非实时单点；实时性需求属 MQTT 透传边界，本任务明确不做。
- **stale 阈值分层**：心跳 10 分钟已由 DEC-024@1.0.0 冻结；遥测 2 小时仍为暂定值，后续冻结需另立决策。
- **导出上限 10000 行（暂定值）**：超出截断由 rowCount 表达；如需更大导出，另立分页下载/对象生命周期决策。
- **活动流归并**：EVENT+ALARM 双源内存归并（单设备量级可控）；若活动源扩展（如命令/耗材），需评估游标归并的可扩展性。
