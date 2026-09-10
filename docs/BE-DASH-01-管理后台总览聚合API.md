# BE-DASH-01 管理后台总览聚合 API

实现：[apps/cloud-api/src/admin/dashboard](../apps/cloud-api/src/admin/dashboard)（service/handler）；REST 契约 [admin-dashboard-api.json](../contracts/rest/admin-dashboard-api.json)；验收测试 [admin-dashboard.test.ts](../apps/cloud-api/test/admin-dashboard.test.ts)（PGlite，固定 10 设备 Fixture）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DASH-01（P2 / 管理后台后端），依赖 BE-DEV-01（deriveConnectivity）、BE-ALM-01、BE-ESG-02、BE-CON-01、BE-CNS-01、BE-CMD-01、DEC-010（四轴分离）、DEC-024（连接阈值 frozen@1.0.0） |
| 事实源 | 指标定义固定并写入 [DTO 注释](../contracts/rest/admin-dashboard-api.json)；在线口径复用 [deriveConnectivity](../apps/cloud-api/src/admin/device/repository.ts)；命令允许性与 BE-CMD-01 共用 [authorization.ts](../apps/cloud-api/src/admin/command/authorization.ts) |
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

**卡片动作（与 BE-CMD-01 完整授权一致）**：共用无副作用函数依次检查 actor command:send、Customer scope、设备状态，以及当前有效 License 中启用的 REMOTE_CONTROL Entitlement；任一授权门失败均不得显示可执行。denyReason = FORBIDDEN（权限/scope/License/Entitlement）或 DEVICE_* 状态原因码。

**查询效率**：基础聚合并行查询，卡片耗材与有效 REMOTE_CONTROL License 均按 deviceId IN 批量读取，无 N+1。

## 3. 验收基准与证据（vitest + PGlite，固定 10 设备 Fixture，6 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| Contract/在线率/授权/ESG 可复算 | Customer A：有效 Contract=2（DRAFT/EXPIRED/TERMINATED 排除）；online=4/10、onlineRatePct=40；分布 {Active:2,Expired:1,Renewed:1,ExpiringSoon:1,NONE:5}；今日 ESG 4.0/15/150 kg（昨日行不计） | ✅ |
| 最新告警排序稳定 | ACTIVE 限定、detectedTime 倒序 + id 决胜、固定 5 条；两次查询结果一致；ACKNOWLEDGED/他 Customer 排除 | ✅ |
| 无数据返回 0 而非错误 | 空 Customer C：total/online/rate/ESG/Contract 全 0，alarms/cards 空数组，HTTP 200 | ✅ |
| Customer 汇总不串线 | B 仅见自身 1 台/1 合约/7kg/1 告警；平台角色全平台口径（11 台/3 合约/11kg） | ✅ |
| 卡片动作与 BE-CMD-01 完整授权一致 | 有效 License+REMOTE_CONTROL 才允许；无 License、过期、吊销、Entitlement disabled 均 FORBIDDEN；Maintenance/Suspended/Retired 返回 DEVICE_*；Viewer 全 FORBIDDEN | ✅ |
| 四轴分离与卡片字段 | lifecycle/operational/connectivity/license 独立字段、无 enabled 派生；固件回退台账；连接质量与耗材投影（null=未知 + stale） | ✅ |
| 权限 | dashboard:read 全角色（Viewer 200）；无 actor → 401 | ✅ |

## 4. 未决风险

- **在线阈值已冻结**：DEC-024@1.0.0 固定 `now-lastHeartbeatAt <= 600 秒` 为 ONLINE（包含边界），以 generatedAt 为唯一时间基准。
- **ESG 依赖预聚合**：今日数值来自 esg_daily_summary（BE-ESG-01 聚合管道）；当日管道延迟时总览反映最近已聚合快照，不做实时补齐（与 BE-ESG-02 只读口径一致）。
- **卡片固定前 10 台**：scope 内 deviceId 升序选择（DTO 已声明）；若需按告警/在线优先排序，另立任务与指标定义。
- **denyReason 粒度**：FORBIDDEN 有意合并 actor、scope、License 与 Entitlement 拒绝，避免向无权主体暴露授权细节；设备状态仍返回稳定 DEVICE_* 码。

## 5. 状态边界与发布 Gate

- `module implemented`：聚合、完整 Command 授权投影、契约与本地回归已实现。
- `production wired`：Admin Router 与 Lambda 组合根已接线。
- `target verified`：**NOT RUN**；尚无绑定当前提交的目标 AWS 聚合与租户验收回执。
- 本地统一验证：`pnpm verify`。历史审计快照：[BE-MED-RBAC-AUD-DASH-SET 全面复盘检查报告](audit/BE-MED-RBAC-AUD-DASH-SET全面复盘检查报告-2026-09-09.md)。
- 发布证据：[BE-MED/RBAC/AUD/DASH/SET AWS 验收证据采集说明](audit/evidence/BE-MED-RBAC-AUD-DASH-SET-AWS验收证据采集说明.md)，执行 `pnpm check:aws-med-rbac-aud-dash-set-evidence`。
