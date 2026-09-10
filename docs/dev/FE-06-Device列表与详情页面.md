# FE-06 Device 列表与详情页面

实现：[apps/admin-web/src/pages/devices](../../apps/admin-web/src/pages/devices/DeviceGroupsPage.tsx)；测试：[device-groups.test.tsx](../../apps/admin-web/test/device-groups.test.tsx)、[device-view.test.tsx](../../apps/admin-web/test/device-view.test.tsx)。

## 0. 交付状态

| 层级 | 当前状态 | 可复核证据 |
|---|---|---|
| module present | **PASS** | 页面、controller、API 适配和专项测试已提交；`pnpm --filter @fdp/admin-web typecheck` |
| app integrated | **PASS** | `/devices/groups`、`/devices/view` 已进入组合根和交付清单；`pnpm check:admin-web-delivery` |
| browser verified | **PASS（本地）** | Chromium 覆盖真实路由、媒体对象、活动、时区、分页与失败呈现；`pnpm check:admin-web-e2e` |
| target integrated | **NOT RUN / NO RECEIPT** | 尚无与当前提交绑定的真实 Cognito、部署后 API 和跨 Customer 回执；`pnpm check:admin-web-target-evidence` 当前应失败关闭 |

审计基线与整改来源：[FE-06至FE-10 全面复盘检查报告](../audit/FE-06至FE-10全面复盘检查报告-2026-09-10.md)；目标环境采集规则：[FE-06～FE-10 目标环境验收证据采集说明](../audit/evidence/FE-06至FE-10-目标环境验收证据采集说明.md)。四层状态相互独立，本地 PASS 不提升 `target integrated`。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-06（P1），依赖 FE-02、BE-DEV-01、BE-DEV-05、DEC-009、DEC-010（均已交付/冻结） |
| 列表事实源 | BE-DEV-01 `listDevices`（四轴组合筛选 + 键集游标）/`getDevice` |
| 控制台事实源 | BE-DEV-05 `getDeviceConsole`（components/metrics/network/consumables/recentAlarms/contract/esgLast7Days/latestMedia）；不请求原始 Telemetry 长期表 |
| 媒体 | DEC-009：仅最新授权 Media；经 BE-MED-01 签发短期下载 URL 后渲染图片或受控视频对象；手动刷新，不标注“实时视频”且无实时流控制 |
| 历史 | BE-DEV-05 `listDeviceActivities`：展示 Alarm/Event 活动并按游标加载 |
| 筛选选项 | Site API 权威全集提供 Region/Subregion/Site，Device API 全量分页提供设备选项，禁止从当前结果页反推 |
| 功能边界 | 状态操作（启动/停止/禁用等）由 FE-07 提供；本页“管理”入口跳转 `/devices/manage` |

### 原型偏差（无 API 来源不伪造）

- 原型“设备当前运作状态”（搅拌器/热泵/排气扇/舱门启停）无 API 来源 → 不展示；部件状态区展示契约 `ComponentStatus` 五键（overall/temperature/humidity/weight/gas 传感器健康）。
- 原型“传感器实时数值”改为“最新传感器读数”（BE-DEV-05 整点桶均值 + observedAt/stale），10 类槽位与原型 sensor-grid 一一对应（功耗/湿度/筒仓温度/热泵温度/厨余重量/马达电流/氧气/二氧化碳/甲烷/一氧化二氮）。
- “录入人”列 CT-06 Defer → 不展示（契约测试锁定 Defer 清单）。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `DeviceGroupsPage`（/devices/groups） | 关键字 + Region/Subregion/Site（ScopeFilter）+ 四轴/授权筛选（搜索应用/重置）；列表 11 列（序号/区域/子区域/唯一ID/别名/合约名称/租期/固件/四轴徽标/管理）；嵌入 FE-04 `OnboardingReviewPanel` |
| `DeviceViewPage`（/devices/view） | Region→Subregion→Site→Device 权威选项联动；控制台含 10 类读数、网络、耗材、告警、ESG、静态信息、合约、最新授权媒体对象与活动历史 |
| `device-state.ts` | 10 类传感器目录、部件五键文案、筛选枚举（与契约 enum 一致）、CT-06 覆盖表 |
| `devices-api.ts` | `fetchDevices`、`fetchDevice`、`fetchDeviceConsole`、`fetchDeviceActivities`、`fetchMediaDownloadUrl` |

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 字段覆盖矩阵 100% | CT-06 Adopt/Adapt 元素与覆盖表双向校验 | **LOCAL PASS** |
| 四轴状态视觉上可区分 | 列表/详情渲染独立 FourAxisBadges | **LOCAL PASS** |
| 筛选/分页/时区正确 | 权威 Site/Device 选项全量分页；时间经 TimeText | **LOCAL PASS** |
| 媒体与历史闭环 | 短期 URL 渲染真实对象；activities 支持游标 | **LOCAL PASS** |
| 不同设备切换无数据残留 | 设备切换后旧内容消失 | **LOCAL PASS** |
| stale/unknown 与 403 明确 | 过期、未知和无权均有独立状态 | **LOCAL PASS** |

仓库内证据命令：`pnpm exec vitest run apps/admin-web/test/device-groups.test.tsx apps/admin-web/test/device-view.test.tsx`、`pnpm check:admin-web-delivery`、`pnpm check:admin-web-e2e`、`pnpm verify`。这些命令不替代目标环境 Gate。

## 4. 可追踪问题

| ID | 状态 | Owner | 关闭条件 | 验证命令 |
|---|---|---|---|---|
| FE06-SCOPE-01 | **OPEN / BLOCKED BY CONTRACT** | BE-DEV owner + Product | 若产品仍要求执行器启停状态，先形成正式 API/权限/状态契约，再实现页面；当前禁止伪造 | `rg -n "执行器|搅拌器|热泵|排气扇|舱门" contracts/rest docs/管理后台开发任务清单.md` |
| FE06-TARGET-01 | **NOT RUN / NO RECEIPT** | Release QA | 隔离环境完成 FE-06 工作流、五角色与跨租户验证，回执绑定精确 HEAD 且清理完成 | `pnpm check:admin-web-target-evidence` |

`licenseStatus=None` 与授权轴 `NoLicense` 是已由契约锁定的显示映射，不作为未决缺陷。
