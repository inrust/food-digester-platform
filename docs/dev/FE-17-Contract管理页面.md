# FE-17 Contract 管理页面

实现：[apps/admin-web/src/pages/contracts](../../apps/admin-web/src/pages/contracts/ContractsPage.tsx)；测试：[contracts.test.tsx](../../apps/admin-web/test/contracts.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-17（P1），依赖 FE-02、BE-CON-01（admin-contract-api.json）、BE-CON-02（admin-contract-device-api.json）、DEC-007 |
| 路由 | `/contracts`（列表）、`/contracts/new`（新建）、`/contracts/detail`（详情）——CT-06 矩阵内三页 |
| 权限 | contract:write 仅 PlatformSuperAdmin；contract:read 另含 Operator/Auditor |
| 乐观锁 | 所有写操作 If-Match（version）+ 强制原因（编辑/激活/续约/终止/绑定/解绑） |
| DEC-007 | Contract 与 License 状态并列展示且标签不同；创建不自动激活 License；解绑不撤销 License |
| 边界 | 不实现计费/电子签章/发票/支付；不把 Customer 名称当 Contract 主键 |

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `ContractsPage`（/contracts） | 状态（派生）/客户筛选；客户名按目录按 ID 解析；设备数量（容器经 listContractDevices 确定性计数注入，未知 —）；服务期限；新建/详情导航 |
| `ContractNewPage`（/contracts/new） | 表单（编号/名称/Customer 结构化选择/有效期/联系方式）字段级校验（编号 ≤100、startAt<endAt）；创建 DRAFT（不自动激活 License）→ 第二步 eligible 设备选择关联（同 Customer/非 Retired/无有效关联；无自由文本入口） |
| `ContractDetailPage`（/contracts/detail） | 合约信息（contact 最小权限：Auditor null → 提示不伪造）；动作矩阵（编辑/激活/续约/终止/关联/解绑，version + 强制原因 + ConfirmDialog）；关联设备表（Region/Subregion/Site/ID/别名/固件/四轴状态/租期展示值 + LicenseSummary 独立并列）；绑定（eligible 实时加载）/解绑（不撤销 License 提示）；关联历史（ACTIVE/ENDED） |
| `contract-state.ts` | 状态枚举/矩阵（parity 锁定）、gateContractAction、validateContractForm/validateRenew（字段级）、formatServicePeriod、CONTRACT_COVERAGE（24 锚点） |
| `contracts-api.ts` | list/get/create/update（PATCH If-Match）/activate/renew/terminate + listContractDevices/listAvailableDevices/listContractAssociations/bind/unbind |

## 3. 验收基准与证据（vitest + jsdom，11 例 + parity 1 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 原型字段与动作覆盖 | CT-06 三页 24 个 Adopt/Adapt 元素 ⇄ CONTRACT_COVERAGE 精确一致（parity） | ✅ |
| 编号重复 | 创建 409 CONFLICT → 错误 + requestId 呈现 | ✅ |
| 结束日早于开始日 | validateContractForm 字段级错误（period）+ 提交阻断 | ✅ |
| 无设备 | 绑定提交需 ≥1 台（按钮禁用）；重叠租期 409 呈现 | ✅ |
| 并发冲突 | 所有写操作 If-Match 快照断言；409 VERSION_CONFLICT 经 ErrorNotice 刷新恢复 | ✅ |
| 解绑不改 License | 解绑后 LicenseSummary 仍显示“授权有效”；提示“不撤销 License” | ✅ |
| Region/Site 结构化 | eligible 设备/客户均为结构化选择器，无自由文本地域入口 | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。

## 4. 未决风险

- 列表“设备数量”列依赖容器逐合约调用 listContractDevices（N+1）；如后续契约在列表视图内嵌计数可切换；
- evaluateContract（时间派生复验）未提供 UI 入口（列表状态为查询时点派生值，无需手动复验）；
- 编辑表单的有效期字段仅 DRAFT 渲染（非 DRAFT 走续约），与契约一致。
