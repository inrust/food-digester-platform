# FE-08 License 与 Entitlement 页面

实现：[apps/admin-web/src/pages/licenses](../../apps/admin-web/src/pages/licenses/LicensesPage.tsx)；测试：[licenses.test.tsx](../../apps/admin-web/test/licenses.test.tsx)。

## 0. 交付状态

| 层级 | 当前状态 | 可复核证据 |
|---|---|---|
| module present | **PASS** | License 列表、详情、状态动作和 Entitlement 模块存在；`pnpm --filter @fdp/admin-web typecheck` |
| app integrated | **PASS** | `/licenses`、`listLicenses` 和写操作已进入组合根/交付清单；`pnpm check:admin-web-delivery` |
| browser verified | **PASS（本地 + 目标环境手工验收）** | Chromium 覆盖正式 License 分页、空态、Contract 摘要深链和失败关闭；目标环境由用户于 2026-09-12 手工验收通过；`pnpm check:admin-web-e2e` |
| target integrated | **NOT RUN / NO RECEIPT** | 尚无当前提交对应的 Cognito、部署后 License API 与并发回执；`pnpm check:admin-web-target-evidence` 当前应失败关闭 |

整改依据：[FE-06至FE-10 全面复盘检查报告](../audit/FE-06至FE-10全面复盘检查报告-2026-09-10.md)；目标回执规则：[FE-06～FE-10 目标环境验收证据采集说明](../audit/evidence/FE-06至FE-10-目标环境验收证据采集说明.md)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-08（P1），依赖 FE-02、BE-LIC-01、DEC-007、FE-17（均已交付/冻结） |
| 路由 | `/licenses`（扩展路由，CT-06 矩阵外；license:read = 平台三角色；菜单组“合约管理”） |
| 事实源 | admin-license-api.json：`listLicenses` 正式实体列表及 create/get/history/issue/activate/renew/revoke；终态历史 License 可枚举 |
| DEC-007 | Contract 与 License 状态严格分离：`LicenseSummary` 组件独立展示授权状态，不消费 Contract 状态 |
| 功能边界 | 不计算正式合同费用（页面无金额字段）；evaluate（SYSTEM 时间派生）不在管理页面暴露 |

### FE-17 Contract 集成

Contract 详情按 Customer 分页读取正式 License 实体，为关联设备展示独立的 `LicenseSummary`；点击“查看授权”以 `licenseId` 跳转 `/licenses?licenseId=…` 并自动打开对应详情。摘要只消费 License 状态，不把 Contract 状态映射成授权状态；CT-06 parity、组件测试和 Chromium 深链回归共同锁定该行为。

### 正式列表 API

`GET /api/v1/admin/licenses` 按 Customer scope 返回 License 实体，支持 customer/device/status/keyword 和游标；Expired/Revoked 等终态记录仍可发现。创建候选设备单独来自 Device API，不再把“设备当前授权摘要”冒充 License 列表。

## 2. 状态机与交付物

状态矩阵（`LICENSE_ACTION_MATRIX`，仅管理员动作；时间派生迁移为 SYSTEM 通道）：

| 状态 | 允许动作 |
|---|---|
| Draft | 签发 |
| Issued | 激活（提示要求已到 validFrom） |
| Active | 撤销 |
| ExpiringSoon | 续期 |
| Renewed | （无，待系统结算为 Active） |
| Expired | 撤销 |
| Revoked | （终态，无动作） |

| 模块 | 内容 |
|---|---|
| `LicensesPage`（/licenses） | 状态/关键字筛选（草稿+搜索/重置）；设备授权列表（CursorTable）；详情面板（含 signature/version/effective/createdBy）；签发/激活确认框；续期对话框（newValidTo>validTo 校验）；撤销强制原因；状态时间线 |
| `LicenseSummary` | 可复用授权摘要（状态/有效期/Entitlement/跳转），NoLicense 显示“无授权” |
| `license-state.ts` | 状态矩阵、`gateLicenseAction`（矩阵 ∩ license:write）、Entitlement 文案、日期校验、CT-06 锚点 |
| `licenses-api.ts` | fetchLicenses/createLicense/fetchLicense/fetchLicenseHistory/issueLicense/activateLicense/renewLicense/revokeLicense |

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 正式实体列表 | 分页、搜索及终态历史 License 可枚举 | **LOCAL PASS** |
| Draft 至 Active | 创建、签发、激活逐步回源 | **LOCAL PASS** |
| 续期/到期/撤销 | 日期校验、终态显示和强制原因 | **LOCAL PASS** |
| 冲突可读 | 重复有效 License 返回 409 并呈现 | **LOCAL PASS** |
| 合法动作 | 状态矩阵与角色权限共同门控，只渲染合法动作 | **LOCAL PASS** |
| 历史与 Entitlement | 时间线和三项封闭编码集与契约一致 | **LOCAL PASS** |

仓库内证据命令：`pnpm exec vitest run apps/admin-web/test/licenses.test.tsx apps/cloud-api/test/admin-license.test.ts`、`pnpm check:admin-web-delivery`、`pnpm check:admin-web-e2e`、`pnpm verify`。

## 4. 可追踪问题

| ID | 状态 | Owner | 关闭条件 | 验证命令 |
|---|---|---|---|---|
| FE08-DEP-01 | **CLOSED** | FE-08/FE-17 owner | Contract 详情嵌入独立 LicenseSummary，并以 licenseId 深链 `/licenses`；不得混用 Contract 状态 | `pnpm exec vitest run apps/admin-web/test/contracts.test.tsx apps/admin-web/test/licenses.test.tsx && pnpm check:admin-web-e2e` |
| FE08-TARGET-01 | **NOT RUN / NO RECEIPT** | Release QA | 隔离环境证明历史终态可发现、动作矩阵、409 与角色边界，回执绑定精确 HEAD 并清理 | `pnpm check:admin-web-target-evidence` |

Renewed→Active 由 SYSTEM evaluate 推进是冻结状态机行为，不是管理员页面缺陷。
