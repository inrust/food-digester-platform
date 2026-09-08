# FE-11 ESG 报表与导出页面

实现：[apps/admin-web/src/pages/esg](../../apps/admin-web/src/pages/esg/EsgOverviewPage.tsx)；测试：[esg.test.tsx](../../apps/admin-web/test/esg.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-11（P1），依赖 FE-02（已交付）、BE-ESG-02（admin-esg-api.json，契约已实现） |
| 路由 | `/esg/overview`、`/esg/devices`（CT-06 矩阵内菜单，ALL_ROLES；report:read 全角色，导出门控 export:create = SuperAdmin/Auditor/CustomerAdmin） |
| 数据集 | 概览页 = DAILY_SUMMARY（日汇总）；设备页 = REPORTS（设备提交 Report，含气体均值与全指标） |
| 口径纪律 | “碳排放”显示为“估算 CO2e（kg）”+ 计算版本 + 完整率；固定展示“非第三方核证”；不绘制碳认证结论（DOM 负向断言） |
| 功能边界 | 不直接查询 RDS/S3（仅经 BE-ESG-02 API） |

### 周/月聚合口径（客户端，已披露）

API 仅提供日粒度；周/月切换为客户端聚合：**可加性指标（投料/出料/减量/能耗/估算 CO2e）求和**；**气体均值与完整率取算术平均并在列头标注“平均”**；null（未补齐）不参与、全 null 显示“—”（不伪造）；混合计算版本显示“多版本”。ISO 8601 周键（UTC 基准）。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `EsgOverviewPage`（/esg/overview） | 日/周/月切换；客户筛选（平台角色）；日期区间（用户时区转 UTC，页面展示换算结果）；汇总表（日期/投料/出料/减量/能耗/估算CO2e/完整率/缺失记录/计算版本）；CSV 导出 |
| `EsgDevicesPage`（/esg/devices） | ScopeFilter 四级联动（区域/子区域/站点/设备，DEC-011）；region/subregion 客户端收窄（契约无 region 参数）；设备 × 期间指标表（含 O2/CO2/CH4/N2O 均值）；CSV 导出 |
| `EsgExportPanel`（共享） | 创建导出 → 状态刷新（PENDING/PROCESSING）→ COMPLETED 短期下载链接（含有效期）→ **urlExpired 明确提示“下载链接已过期，请重新导出”且不渲染链接**；FAILED 呈现后端 error |
| `esg-state.ts` | 聚合/ISO 周键/`zonedDateRangeToUtc`（Intl 时区偏移）/格式化（kg/kWh/ppm/%）/权限门/CT-06 锚点表 |
| `esg-api.ts` | fetchEsgDailySummary/fetchEsgReports/fetchEsgCalculationVersions/createEsgExport/fetchEsgExport |

## 3. 验收基准与证据（vitest + jsdom，8 例 + parity 1 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 指标单位/版本/完整率显示 | 概览行 kg/kWh/% 与“估算 CO2e (kg)”列头；计算版本 ID→版本号解析（v1.2.0）；完整率 98.5%；设备页九项指标全量断言 | ✅ |
| 导出筛选与页面一致 | onExport 快照断言 = 已应用筛选 + dataset（概览 DAILY_SUMMARY / 设备 REPORTS） | ✅ |
| 过期下载链接有明确提示 | urlExpired → “下载链接已过期，请重新导出”且无链接；PENDING 无链接；COMPLETED 出链接含有效期 | ✅ |
| 日/周/月切换 | 聚合纯函数测试（求和/平均/null 不伪造/多版本）+ 页面列头“平均”标注 | ✅ |
| 日期按用户时区转 UTC | Asia/Shanghai 2026-09-01 → [2026-08-31T16:00:00Z, 2026-09-01T15:59:59.999Z]；非法区间字段错误 | ✅ |
| 非第三方核证 | 两页固定声明；无“碳认证/已核证/碳信用”字样 | ✅ |
| CT-06 锚点 | esg-overview 6 元素 + esg-device 7 元素 ⇄ testid 集合精确一致 | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。

## 4. 未决风险

- 周/月聚合基于已加载行（游标分页内）；跨页全量聚合需装配层拉全数据（文档化的口径限制）；
- region/subregion 收窄依赖父级注入 deviceScope 映射（设备 → 区域归属）；未覆盖设备在设置区域筛选时不显示；
- EsgOverview（最近聚合窗口元数据）接口未在页面使用——当前以列表数据+计算版本表自足；如需“最近数据窗口”提示可后续接入。
