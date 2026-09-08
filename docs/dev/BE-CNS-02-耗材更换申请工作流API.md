# BE-CNS-02 耗材更换申请工作流 API

实现：[apps/cloud-api/src/consumable/request-service.ts](../../apps/cloud-api/src/consumable/request-service.ts) + [request-handler.ts](../../apps/cloud-api/src/consumable/request-handler.ts)；状态机领域规则：[packages/domain/src/consumable.ts](../../packages/domain/src/consumable.ts)；OpenAPI：[contracts/rest/admin-consumable-request-api.json](../../contracts/rest/admin-consumable-request-api.json)；验收测试：[admin-consumable-request.test.ts](../../apps/cloud-api/test/admin-consumable-request.test.ts)。

> 证据治理：当前本地全仓证据命令为 `pnpm verify`；精确快照与整改闭环见 [全面复盘检查报告](../audit/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md)。目标 AWS 验收必须按 [证据采集说明](../audit/evidence/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md) 生成与待发布提交绑定的回执，并通过 `pnpm check:aws-admin-business-evidence`；缺失回执不得以本地测试替代。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CNS-02（P2 / 管理后台后端），依赖 BE-CNS-01、AUTH-01、DOM-03、DEC-008（均已交付） |
| 状态机 | 领域层迁移表：PENDING→PROCESSING→COMPLETED，PENDING/PROCESSING→CANCELLED；跳级/重复处理/终态迁移 → 409 CONFLICT（与 DB CHECK 大写枚举一致） |
| 幂等 | 同设备同耗材存在开放申请（PENDING/PROCESSING）时重复创建 → 200 返回现有记录 `replayed=true`（无写入/审计）；部分唯一索引 `consumable_requests_one_open_per_device_type`（migration `20260829110000`）并发兜底（P2002 → 重读幂等） |
| 状态迁移 | If-Match 乐观锁（version 条件更新，漂移 → 409 VERSION_CONFLICT）+ 状态条件（并发漂移 → 409）；complete/cancel 强制备注；DOM-03 审计（create/process/complete/cancel 各一次） |
| 授权 | 创建/处理/完成/取消仅授权角色（device:write = PlatformSuperAdmin/PlatformOperator）；查询 device:read + Customer 租户隔离（跨 Customer 详情 → 404，不泄露存在性） |
| 历史字段 | requestedBy/requestedAt/source（固定 ADMIN，协议冻结前仅管理端）/processedBy/processNote/completedAt；终态行保留可查询 |
| 功能边界 | 原型未定义设备侧申请 Topic → 仅管理端创建；不实现工单派遣、库存、物流或短信联系 |

## 2. 端点

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/consumable-requests` | `device:write` | 创建（201；开放申请重复 → 200 replayed）；设备须存在、已分配 Customer、非 Retired |
| `GET /api/v1/admin/consumable-requests` | `device:read` | 列表（customerId/deviceId/status/consumableType 筛选；Customer 强制本 Customer） |
| `GET .../{requestId}` | `device:read` | 详情（跨 Customer → 404） |
| `POST .../{requestId}/process` | `device:write` | PENDING→PROCESSING（If-Match；记录 processedBy） |
| `POST .../{requestId}/complete` | `device:write` | PROCESSING→COMPLETED（If-Match + 强制处理备注；记录 completedAt） |
| `POST .../{requestId}/cancel` | `device:write` | PENDING/PROCESSING→CANCELLED（If-Match + 强制原因） |

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| “未处理→正在处理→完成处理”完整可复验 | 创建 PENDING（source=ADMIN/requestedBy/requestedAt）→ process（processedBy）→ complete（processNote/completedAt）；版本递增；终态可再查询 | ✅ |
| 跳级、重复处理失败 | PENDING→COMPLETED 409；COMPLETED→PROCESSING/重复完成 409；终态不可迁移 409 | ✅ |
| 重复申请幂等 | 开放申请重复创建 200 replayed=true 返回现有记录（无新行/新审计）；PROCESSING 仍幂等；不同耗材互不影响；完成后可再申请 | ✅ |
| If-Match | 缺失 400；漂移 409 VERSION_CONFLICT；写被拒无审计污染 | ✅ |
| 跨 Customer / 未授权角色失败 | CustomerAdmin 创建/处理 403（无 device:write）；跨 Customer 详情 404、列表隔离；Auditor 只读；未认证 401 | ✅ |
| 完成后保留完整历史 | 终态行含全部历史字段；审计 create/process/complete/cancel 各恰好一次 | ✅ |
| 附加 | 非法类型 400；设备不存在 404；未分配 Customer/Retired 409；DTO 与契约一致；无 AWS 依赖 | ✅ |

领域单测：`packages/domain/test/consumable.test.ts`（状态机回归）。契约测试：`node --import tsx --test contracts/rest/admin-consumable-request-api.test.ts`。

## 4. 未决风险

- 申请来源固定 ADMIN（DEC-008 边界：设备侧申请 Topic 协议冻结前不开放）；
- 取消/完成备注统一入 `processNote` 字段（Schema 无独立取消原因列）；审计 reason 保留完整语义；
- 无独立状态历史表（历史 = 终态行 + 审计日志，与 DEC-009 审计模型一致）。
