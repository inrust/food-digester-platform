# FE-06 Device 列表与详情页面

实现：[apps/admin-web/src/pages/devices](../../apps/admin-web/src/pages/devices/DeviceGroupsPage.tsx)；测试：[device-groups.test.tsx](../../apps/admin-web/test/device-groups.test.tsx)、[device-view.test.tsx](../../apps/admin-web/test/device-view.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-06（P1），依赖 FE-02、BE-DEV-01、BE-DEV-05、DEC-009、DEC-010（均已交付/冻结） |
| 列表事实源 | BE-DEV-01 `listDevices`（四轴组合筛选 + 键集游标）/`getDevice` |
| 控制台事实源 | BE-DEV-05 `getDeviceConsole`（components/metrics/network/consumables/recentAlarms/contract/esgLast7Days/latestMedia）；不请求原始 Telemetry 长期表 |
| 媒体 | DEC-009：仅最新授权 Media 元数据 + 手动刷新；不标注“实时视频”、无播放/停止按钮、无播放计时（原型 camPlay/camStop 已 Reject） |
| 功能边界 | 状态操作（启动/停止/禁用等）由 FE-07 提供；本页“管理”入口跳转 `/devices/manage` |

### 原型偏差（无 API 来源不伪造）

- 原型“设备当前运作状态”（搅拌器/热泵/排气扇/舱门启停）无 API 来源 → 不展示；部件状态区展示契约 `ComponentStatus` 五键（overall/temperature/humidity/weight/gas 传感器健康）。
- 原型“传感器实时数值”改为“最新传感器读数”（BE-DEV-05 整点桶均值 + observedAt/stale），10 类槽位与原型 sensor-grid 一一对应（功耗/湿度/筒仓温度/热泵温度/厨余重量/马达电流/氧气/二氧化碳/甲烷/一氧化二氮）。
- “录入人”列 CT-06 Defer → 不展示（契约测试锁定 Defer 清单）。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `DeviceGroupsPage`（/devices/groups） | 关键字 + Region/Subregion/Site（ScopeFilter）+ 四轴/授权筛选（搜索应用/重置）；列表 11 列（序号/区域/子区域/唯一ID/别名/合约名称/租期/固件/四轴徽标/管理）；嵌入 FE-04 `OnboardingReviewPanel` |
| `DeviceViewPage`（/devices/view） | Region→Subregion→Site→Device 四级联动 + 应用；控制台：部件状态、10 类读数（avg/min/max + 单位 + observedAt/stale）、网络、耗材（复用 ConsumableGauge）、最近告警（5）、近 7 日 ESG（空槽“—”）、静态信息（getDevice）、关联合约、最新授权媒体 + 手动刷新 |
| `device-state.ts` | 10 类传感器目录、部件五键文案、筛选枚举（与契约 enum 一致）、CT-06 覆盖表 |
| `devices-api.ts` | `fetchDevices`（八项筛选 + 游标）、`fetchDevice`、`fetchDeviceConsole` |

## 3. 验收基准与证据（vitest + jsdom）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 字段覆盖矩阵 100% | 契约测试：CT-06 device-view/device-group 全部 Adopt/Adapt 元素 ⊆ 覆盖表（且覆盖表无多余键）；Defer 仅录入人一例 | ✅ |
| 四轴状态视觉上可区分 | 列表/详情均渲染 FourAxisBadges（四轴独立徽标，axis/data-value 属性可定位） | ✅ |
| 筛选/分页/时区正确 | 关键字+四轴+授权+Region/Subregion/Site 联动进入查询；CursorTable 游标分页；时间经 TimeText（UTC→用户时区） | ✅ |
| 不同设备切换无数据残留 | 控制台容器 `key=deviceId` 强制重建；rerender 断言旧设备内容消失 | ✅ |
| stale/unknown 明确 | metrics stale → “数据过期”；observedAt null → “无观测数据”；传感器/ESG/耗材缺失值 “—” | ✅ |
| 无权设备返回明确状态 | 403 → ErrorNotice 无权提示 | ✅ |
| 枚举对齐 | 筛选枚举与 listDevices 参数 enum、传感器键与 MetricsBlock 描述键集、部件键与 ComponentStatus 逐一对齐（契约测试） | ✅ |

当前证据命令：`pnpm vitest run apps/admin-web/test`、`pnpm --filter @fdp/admin-web typecheck`、`pnpm verify`。任务文档不固化易漂移计数。

## 4. 未决风险

- 原型“设备当前运作状态”（执行器启停）无 API 来源，待 BE 契约补充后方可展示；
- 媒体区仅元数据 + 手动刷新；媒体内容预览需 BE-MED-01 授权下载 URL 的页面集成（FE-14 范围）；
- `licenseStatus` 筛选 `None` 与授权轴 `NoLicense` 命名差异已按契约原样对接（契约测试锁定）。
