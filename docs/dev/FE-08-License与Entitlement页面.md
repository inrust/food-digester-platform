# FE-08 License 与 Entitlement 页面

实现：[apps/admin-web/src/pages/licenses](../../apps/admin-web/src/pages/licenses/LicensesPage.tsx)；测试：[licenses.test.tsx](../../apps/admin-web/test/licenses.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-08（P1），依赖 FE-02（已交付）、BE-LIC-01（契约 + 后端已实现）、DEC-007、FE-17（未交付，见偏差说明） |
| 路由 | `/licenses`（扩展路由，CT-06 矩阵外；license:read = 平台三角色；菜单组“合约管理”） |
| 事实源 | admin-license-api.json：create(Draft)/getLicense/listLicenseHistory/issue/activate/renew/revoke；列表复用 BE-DEV-01 listDevices 的 Device.license 摘要 |
| DEC-007 | Contract 与 License 状态严格分离：`LicenseSummary` 组件独立展示授权状态，不消费 Contract 状态 |
| 功能边界 | 不计算正式合同费用（页面无金额字段）；evaluate（SYSTEM 时间派生）不在管理页面暴露 |

### 依赖偏差（FE-17 未交付）

任务声明“从 Contract 详情展示独立的授权摘要与跳转”，但 FE-17（合约页面）未交付。本次以可复用组件 `LicenseSummary`（testid `license-summary`，含“查看授权”跳转回调）先行交付，FE-17 交付合约详情页时直接嵌入；CT-06 parity 测试已锁定 `contract-detail.field.licenseSummary` 锚点。

### 列表无独立 API 的处理

BE-LIC-01 无全量 License 列表端点，`getDeviceLicense` 仅为 planned API。列表采用“每设备当前授权”视角：`listDevices`（licenseStatus/keyword 筛选）+ `Device.license` 摘要（licenseId/status/validFrom/validTo/entitlements）；NoLicense 设备明确显示“无授权”，详情按钮禁用。历史 License（Expired/Revoked 后重建等）不在列表呈现，明细经 getLicense + listLicenseHistory 获取。

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
| `licenses-api.ts` | createLicense/fetchLicense/fetchLicenseHistory/issueLicense/activateLicense/renewLicense/revokeLicense |

## 3. 验收基准与证据（vitest + jsdom，10 例 + parity 1 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| NoLicense 至 Active E2E | 创建 Draft（设备+有效期+Entitlement 勾选）→ 签发（确认框）→ 激活（提示 validFrom）→ Active 生效展示，逐步 rerender 推进，每步回源刷新 | ✅ |
| 续期 | ExpiringSoon → 新日期必须晚于当前（本地校验 + 禁用提交）→ Renewed 提示 | ✅ |
| 到期展示 | Expired + effective=false 展示“已到期/未生效” | ✅ |
| 撤销 | 强制原因（空原因确认禁用）→ Revoked | ✅ |
| 两个有效 License 错误可读 | 创建遇 409 CONFLICT → 后端 message（含冲突 License ID/状态）原样呈现 + 错误码 | ✅ |
| 只显示当前状态允许动作 | 7 状态 × 4 动作矩阵断言；Auditor 无创建按钮且动作全禁 | ✅ |
| 历史时间线 | from→to/操作人/原因/时间渲染；空态/加载态 | ✅ |
| Entitlement 配置 | 创建表单三选 checkbox（至少一项）；编码集与契约 enum 一致（parity，OTA 不改名） | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。

## 4. 未决风险

- 无全量 License 列表 API：跨设备检索只能经 listDevices 的 licenseStatus 筛选（每设备当前授权）；历史 License 档案需进入详情历史查看；
- `getDeviceLicense` 仍是 planned API：合约详情页（FE-17）嵌入授权摘要时使用 listDevices/getDevice 的 license 摘要 + getLicense 详情，FE-17 落地时复核；
- Renewed→Active 依赖 SYSTEM evaluate 结算，页面提示“待系统结算”，不提供管理员手动结算入口。
