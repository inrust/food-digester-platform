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

## 当前分层状态

| 层级 | 当前结论 | 证据边界 |
|---|---|---|
| module present | PASS | 页面、状态逻辑、API adapter 与定向测试存在。 |
| app integrated | PASS | 两个路由均由正式 controller 接入组合根；controller 收集完整游标范围后聚合。 |
| browser verified | PASS | 本地 Chromium mock E2E 覆盖正式路由与交互；不等同真实部署。 |
| target integrated | NOT RUN / NO RECEIPT | 尚无绑定精确提交、真实 Cognito 与已部署 API 的目标回执。 |

当前整改依据：[FE-11 至 FE-15 全面复盘检查报告](../audit/FE-11至FE-15全面复盘检查报告-2026-09-12.md)。目标环境采集依据：[FE-11 至 FE-15 目标环境验收证据采集说明](../audit/evidence/FE-11至FE-15-目标环境验收证据采集说明.md)，发布时显式执行 `pnpm check:admin-web-fe11-15-target-evidence`。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `EsgOverviewPage`（/esg/overview） | 日/周/月切换；客户筛选（平台角色）；日期区间（用户时区转 UTC，页面展示换算结果）；汇总表（日期/投料/出料/减量/能耗/估算CO2e/完整率/缺失记录/计算版本）；CSV 导出 |
| `EsgDevicesPage`（/esg/devices） | ScopeFilter 四级联动（区域/子区域/站点/设备，DEC-011）；region/subregion 客户端收窄（契约无 region 参数）；设备 × 期间指标表（含 O2/CO2/CH4/N2O 均值）；CSV 导出 |
| `EsgExportPanel`（共享） | 创建导出 → 状态刷新（PENDING/PROCESSING）→ COMPLETED 短期下载链接（含有效期）→ **urlExpired 明确提示“下载链接已过期，请重新导出”且不渲染链接**；FAILED 呈现后端 error |
| `esg-state.ts` | 聚合/ISO 周键/`zonedDateRangeToUtc`（Intl 时区偏移）/格式化（kg/kWh/ppm/%）/权限门/CT-06 锚点表 |
| `esg-api.ts` | fetchEsgDailySummary/fetchEsgReports/fetchEsgCalculationVersions/createEsgExport/fetchEsgExport |

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 指标单位/版本/完整率显示 | 概览行 kg/kWh/% 与“估算 CO2e (kg)”列头；计算版本映射、完整率与设备指标断言 | 仓库内 PASS |
| 导出筛选与页面一致 | onExport 快照断言 = 已应用筛选 + dataset（概览 DAILY_SUMMARY / 设备 REPORTS） | 仓库内 PASS |
| 过期下载链接有明确提示 | urlExpired 时提示重新导出且无链接；未完成无链接；完成后显示短链 | 仓库内 PASS |
| 日/周/月切换 | 完整游标范围聚合；求和/平均/null 不伪造/多版本 | 仓库内 PASS |
| 日期按用户时区转 UTC | 严格日期校验、Asia/Shanghai 及 America/New_York 春秋 DST 边界 | 仓库内 PASS |
| 非第三方核证 | 两页固定声明；无碳认证结论 | 仓库内 PASS |
| CT-06 锚点 | 页面 testid 与覆盖矩阵 parity | 仓库内 PASS |

验证命令：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm check:admin-web-delivery`、`pnpm check:admin-web-e2e`。结果只支持前三层；目标层必须另跑独立回执 Gate。

## 4. 未决风险

- region/subregion 收窄依赖父级注入 deviceScope 映射（设备 → 区域归属）；未覆盖设备在设置区域筛选时不显示；
- EsgOverview（最近聚合窗口元数据）接口未在页面使用——当前以列表数据+计算版本表自足；如需“最近数据窗口”提示可后续接入。
- Owner：Release Engineering；关闭条件：取得符合回执 Schema 且绑定待发布提交的目标环境 PASS；当前保持 NOT RUN / NO RECEIPT。
