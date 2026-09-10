# FE-10 Alarm/Event/Tamper 页面

实现：[apps/admin-web/src/pages/alarms](../../apps/admin-web/src/pages/alarms/AlarmsPage.tsx)；测试：[alarms.test.tsx](../../apps/admin-web/test/alarms.test.tsx)。

## 0. 交付状态

| 层级 | 当前状态 | 可复核证据 |
|---|---|---|
| module present | **PASS** | 三类列表、状态动作、结构化筛选和 URL 状态模块存在；`pnpm --filter @fdp/admin-web typecheck` |
| app integrated | **PASS** | `/alarms` 已接入组合根、权威选项源和交付清单；`pnpm check:admin-web-delivery` |
| browser verified | **PASS（本地）** | Chromium 覆盖返回/前进和 Critical 计算样式；`pnpm check:admin-web-e2e` |
| target integrated | **NOT RUN / NO RECEIPT** | 尚无当前提交对应的真实 Cognito、部署后 Alarm API 与跨租户回执；`pnpm check:admin-web-target-evidence` 当前应失败关闭 |

整改依据：[FE-06至FE-10 全面复盘检查报告](../audit/FE-06至FE-10全面复盘检查报告-2026-09-10.md)；目标回执规则：[FE-06～FE-10 目标环境验收证据采集说明](../audit/evidence/FE-06至FE-10-目标环境验收证据采集说明.md)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-10（P1），依赖 FE-02（已交付）、BE-ALM-01（admin-alarm-api.json，契约 + 后端已实现） |
| 路由 | `/alarms`（扩展路由，告警与事件；alarm:read = 全部五角色；Customer 角色租户隔离由服务端强制，跨 Customer 详情/处理 → 404） |
| 状态机 | ACTIVE→确认/清除、ACKNOWLEDGED→清除、CLEARED 终态（领域层封闭校验；矩阵与契约 parity 锁定） |
| 幂等 | 重复确认/清除 replayed=true（无写入/审计/领域事件），页面提示“重复操作已幂等忽略” |
| 功能边界 | 只呈现业务告警/事件/防拆；不展示 CloudWatch/SQS/RDS 等 AWS 运维告警（DOM 负向断言锁定） |

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `AlarmsPage`（/alarms） | 三 Tab；结构化 Customer→Site→Device 选择；告警详情/处置；Event/Tamper 只读列表；键集分页；CRITICAL 真实视觉样式 |
| `alarm-state.ts` | 状态机矩阵 + `gateAlarmAction`（矩阵 ∩ alarm:write）；severity/status 枚举与文案；**筛选 ⇄ URL 同步**（`urlStateToSearch`/`urlStateFromSearch`，非法枚举静默丢弃） |
| `alarms-api.ts` | fetchAlarms/fetchAlarm/acknowledgeAlarm/clearAlarm/fetchDeviceEvents/fetchTamperEvents（筛选 + cursor 查询串） |
| `CursorTable` 扩展 | 新增可选 `rowClassName`（CRITICAL 显著行；向后兼容） |

筛选：severity/status/device/site/customer（平台角色）/时间范围；Site/Device 选项由权威 API 全量分页并按 Customer/Site 联动。controller 以 history 导航写入 URL，并监听浏览器返回/前进后从 `location.search` 回灌页面状态。

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 状态与幂等 | 确认/清除状态机、原因、重复操作提示正确 | **LOCAL PASS** |
| 结构化筛选 | Customer/Site/Device 联动且仅使用可见权威选项 | **LOCAL PASS** |
| URL 双向同步 | 直接链接、筛选、浏览器返回/前进一致 | **LOCAL PASS** |
| 跨 Customer 与角色 | 404/403、隐藏客户筛选和动作权限可区分 | **LOCAL PASS** |
| Critical 显著 | class、CSS 和 Chromium computed style 均有断言 | **LOCAL PASS** |
| 业务/运维分离 | 页面不混入 CloudWatch/SQS/RDS | **LOCAL PASS** |

仓库内证据命令：`pnpm exec vitest run apps/admin-web/test/alarms.test.tsx apps/admin-web/test/contract-parity.test.ts`、`pnpm check:admin-web-delivery`、`pnpm check:admin-web-e2e`、`pnpm verify`。

## 4. 可追踪问题

| ID | 状态 | Owner | 关闭条件 | 验证命令 |
|---|---|---|---|---|
| FE10-URL-01 | **CLOSED / ACCEPTED DESIGN** | FE-10 owner | 当前 Tab 单独序列化且切换时按 URL 回灌，浏览器返回/前进测试通过 | `pnpm check:admin-web-e2e` |
| FE10-TARGET-01 | **NOT RUN / NO RECEIPT** | Release QA | 隔离环境证明结构化 scope、真实路由历史、Critical 样式、处置幂等与跨租户拒绝，绑定精确 HEAD 并清理 | `pnpm check:admin-web-target-evidence` |
