# BE-DASH-01 管理后台总览聚合 API

实现：[apps/cloud-api/src/admin/dashboard](../apps/cloud-api/src/admin/dashboard)（service/handler）；REST 契约 [admin-dashboard-api.json](../contracts/rest/admin-dashboard-api.json)；验收测试 [admin-dashboard.test.ts](../apps/cloud-api/test/admin-dashboard.test.ts)（6 项，PGlite，固定 10 设备 Fixture）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DASH-01（P2 / 管理后台后端），依赖 BE-DEV-01（deriveConnectivity 10 分钟暂定阈值）、BE-ALM-01（alarms）、BE-ESG-02（esg_daily_summary 预聚合）、BE-CON-01（contracts）、BE-CNS-01（consumable_projections）、BE-CMD-01（命令目录 + 状态门 + command:send 矩阵）、DEC-010（四轴分离，frozen） |
| 事实源 | 指标定义固定并写入 [DTO 注释](../contracts/rest/admin-dashboard-api.json)（分母/时间窗口）；在线口径复用 [deriveConnectivity](../apps/cloud-api/src/admin/device/repository.ts)（lastHeartbeatAt ≤ 10 分钟，暂定值，不读存储字段）；命令允许性复用领域层 COMMAND_CATALOG + resolveCommandGateStatus 与契约层 commandDenyReason |
| Schema 变更 | 无（全部为既有表只读聚合） |
| 功能边界 | 不返回 AWS CPU、队列深度等运维指标；卡片动作仅描述（command/allowed/denyReason），不在查询中执行命令 |

## 2. 关键设计

**路由**：`GET /api/v1/admin/dashboard/overview`（dashboard:read，全 5 角色持有）。Customer actor 强制 actor.customerId scope（汇总不串线）；平台角色全平台口径。

**指标定义（固定）**：
- 有效 Contract 总数：status ∉ {DRAFT, TERMINATED} 且 startAt ≤ generatedAt < endAt（EFFECTIVE + EXPIRING_SOON）；
- 设备总数/在线数/在线率：分母为 scope 内 devices；online = lastHeartbeatAt 距 generatedAt ≤ 10 分钟；onlineRatePct 保留 1 位小数，total=0 → 0（无数据返回 0 而非错误）；
- 授权状态分布：device_latest_state.licenseStatus → 设备数，无状态行计入 NONE 桶（License 轴独立，DEC-010）；
- 今日 ESG：esg_daily_summary 按 summaryDate = generatedAt 的 UTC 日历日 + scope 内设备求和（carbonReductionKg / powerConsumptionKwh / feedingWeightKg），无数据为 0；
- 最新业务告警：status = ACTIVE，detectedTime 倒序 + id 决胜，固定 5 条（排序稳定）；
- 设备卡片：scope 内 deviceId 升序固定前 10 台——四轴独立字段（lifecycleStatus / operationalStatus / connectivity / licenseStatus，不派生 enabled 单字段）、固件（最近上报优先、回退台账）、连接质量（signalStrength/networkType）、耗材投影（remainingPercent null=未知 + stale，DEC-008）、全目录 22 条动作描述。

**卡片动作（与 BE-CMD-01 权限矩阵一致）**：allowed = actor 持有 command:send 且设备状态门允许；denyReason = FORBIDDEN（actor 无 command:send，如 CustomerViewer/Auditor）或契约层原因码（DEVICE_RETIRED / DEVICE_SUSPENDED_RESTRICTED / DEVICE_MAINTENANCE_RESTRICTED）；仅描述不执行。

**查询效率**：5 次并行查询（devices / latestState IN / contract count / esg aggregate / alarm top5）+ 1 次卡片耗材 IN 查询，无 N+1。

## 3. 验收基准与证据（vitest + PGlite，固定 10 设备 Fixture，6 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| Contract/在线率/授权/ESG 可复算 | Customer A：有效 Contract=2（DRAFT/EXPIRED/TERMINATED 排除）；online=4/10、onlineRatePct=40；分布 {Active:2,Expired:1,Renewed:1,ExpiringSoon:1,NONE:5}；今日 ESG 4.0/15/150 kg（昨日行不计） | ✅ |
| 最新告警排序稳定 | ACTIVE 限定、detectedTime 倒序 + id 决胜、固定 5 条；两次查询结果一致；ACKNOWLEDGED/他 Customer 排除 | ✅ |
| 无数据返回 0 而非错误 | 空 Customer C：total/online/rate/ESG/Contract 全 0，alarms/cards 空数组，HTTP 200 | ✅ |
| Customer 汇总不串线 | B 仅见自身 1 台/1 合约/7kg/1 告警；平台角色全平台口径（11 台/3 合约/11kg） | ✅ |
| 卡片动作与 BE-CMD-01 矩阵一致 | Active → START allowed；Maintenance → DEVICE_MAINTENANCE_RESTRICTED；Suspended → DEVICE_SUSPENDED_RESTRICTED；Retired → 全 DEVICE_RETIRED；CustomerViewer → 全 FORBIDDEN；22 条全目录 | ✅ |
| 四轴分离与卡片字段 | lifecycle/operational/connectivity/license 独立字段、无 enabled 派生；固件回退台账；连接质量与耗材投影（null=未知 + stale） | ✅ |
| 权限 | dashboard:read 全角色（Viewer 200）；无 actor → 401 | ✅ |

## 4. 未决风险

- **在线阈值为暂定值**（10 分钟，BE-DEV-01 口径）：冻结需登记决策；当前以 generatedAt 为唯一时间基准保证可复算。
- **ESG 依赖预聚合**：今日数值来自 esg_daily_summary（BE-ESG-01 聚合管道）；当日管道延迟时总览反映最近已聚合快照，不做实时补齐（与 BE-ESG-02 只读口径一致）。
- **卡片固定前 10 台**：scope 内 deviceId 升序选择（DTO 已声明）；若需按告警/在线优先排序，另立任务与指标定义。
- **denyReason 扩展码 FORBIDDEN**：契约层 commandDenyReason 仅覆盖设备状态门；FORBIDDEN 为本任务新增的 actor 权限原因码（已写入 OpenAPI 枚举），若 BE-CMD-01 后续对齐，上提到契约目录。
