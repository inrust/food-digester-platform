# BE-CON-02 Contract 与 Device 关联 API

实现：[apps/cloud-api/src/admin/contract-device](../../apps/cloud-api/src/admin/contract-device/index.ts)；领域规则（关联状态/窗口/重叠判定）：[packages/domain/src/contract.ts](../../packages/domain/src/contract.ts)；OpenAPI：[contracts/rest/admin-contract-device-api.json](../../contracts/rest/admin-contract-device-api.json)；验收测试：[admin-contract-device.test.ts](../../apps/cloud-api/test/admin-contract-device.test.ts)。

> 证据治理：当前本地全仓证据命令为 `pnpm verify`；精确快照与整改闭环见 [全面复盘检查报告](../audit/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md)。目标 AWS 验收必须按 [证据采集说明](../audit/evidence/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md) 生成与待发布提交绑定的回执，并通过 `pnpm check:aws-admin-business-evidence`；缺失回执不得以本地测试替代。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CON-02（P1 / 管理后台后端），依赖 BE-CON-01、BE-DEV-01、BE-LIC-01、DOM-03、DEC-007（均已交付） |
| 数据模型 | 复用 DB-01 `contract_devices`（ACTIVE/ENDED + valid_from/valid_to + ended_at 即关联历史）；排他约束 `contract_devices_no_overlap`（btree_gist，同设备 ACTIVE 关联时间窗不重叠）为 DB 兜底 |
| 约束 | 设备与 Contract 同 Customer（跨 Customer → 409）；Retired 设备不可关联；合同须可关联（DRAFT/EFFECTIVE/EXPIRING_SOON，领域 `assertContractAssociatable`）；关联窗口落在合同窗口内（领域 `assertAssociationWindow`） |
| 重叠租期 | 服务预检（`windowsOverlap` 半开区间）→ 409；DB 排他约束并发兜底（23P01 → 409） |
| 联动（DEC-007） | 关联事务不改变 Device lifecycle、不联动 License；解绑不撤销 License；关联不替代 Assignment、不代表 Entitlement |
| 审计 | `contract.devices.bind` / `contract.devices.unbind` 各一次（批量一条审计携带 deviceIds；DOM-03 audited 单事务全成或全败） |

## 2. 端点

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/admin/contracts/{id}/devices` | `contract:read` | 已关联设备：聚焦快照（ID、别名、Region/Subregion/Site、四轴状态 lifecycle/operational/connectivity/license、固件、心跳）+ 租期展示值（validFrom/validTo/status/endedAt） |
| `GET .../available-devices` | `contract:read` | 可关联设备：同 Customer、非 Retired、当前无 ACTIVE 关联 |
| `GET .../associations` | `contract:read` | 关联历史（ACTIVE/ENDED 全部行，创建倒序） |
| `POST .../devices/bind` | `contract:write`（仅 SuperAdmin） | 批量关联：deviceIds 非空、强制原因；窗口缺省 = 合同窗口；201 |
| `POST .../devices/unbind` | `contract:write` | 批量解绑：强制原因；任一设备无本合同 ACTIVE 关联 → 409 全部回滚；解绑闭合窗口（status=ENDED，validTo=max(now, validFrom)） |

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 未关联合约设备列表准确 | available-devices：含空闲设备；不含已关联/Retired/跨 Customer | ✅ |
| 批量操作全成或全败 | bind 含不存在(404)/跨 Customer(409)/Retired(409) 设备 → 全部回滚零写入零 SUCCESS 审计；unbind 部分无关联 → 409 且其余仍 ACTIVE | ✅ |
| 跨 Customer、重复关联和重叠租期失败 | 跨 Customer 409；同合同重复关联 409；同设备重叠租期 409（预检 + 排他约束兜底）；解绑后相邻窗口可关联；窗口超出合同窗口 400；EXPIRED/TERMINATED 合同 409 | ✅ |
| 解绑不误撤销 License | 解绑后 License 仍 Active、Device lifecycle 不变、关联行 ENDED + 窗口闭合 | ✅ |
| 所有变化可审计 | bind/unbind 各恰好一次 SUCCESS 审计（含 deviceIds/reason）；关联历史返回全部 ENDED 行 | ✅ |
| Contract 详情设备视图 | 四轴状态（Active/RUNNING/ONLINE/Active License）、固件 FW1.2、别名、Region/Subregion/Site、租期 validFrom/validTo；无心跳 OFFLINE、无 License null | ✅ |
| 附加 | 权限矩阵（Operator/Auditor 只读、写 403；Customer 403；未认证 401；缺原因/空数组 400；404）；DTO 与契约封闭一致；无 AWS 依赖 | ✅ |

领域单测：`packages/domain/test/contract.test.ts`（关联规则回归）。契约测试：`node --import tsx --test contracts/rest/admin-contract-device-api.test.ts`。

## 4. 未决风险

- 无"联动待处理领域事件"实例：DEC-007 明确解绑不联动 License，当前无业务规则要求联动，故未产出领域事件（如未来引入，经 Outbox 扩展即可）；
- 关联窗口默认 = 合同窗口；合同续约（BE-CON-01 renew）不自动延长既有 ACTIVE 关联（validTo 保持原值），如需联动续约需新任务定义；
- 关联历史无独立历史表（contract_devices 行即历史，append-only 由 status 迁移保证）。
