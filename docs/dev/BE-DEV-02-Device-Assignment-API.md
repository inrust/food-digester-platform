# BE-DEV-02 Device Assignment API

实现：[apps/cloud-api/src/admin/device-assignment](../apps/cloud-api/src/admin/device-assignment/index.ts)；OpenAPI：[contracts/rest/admin-device-assignment-api.json](../contracts/rest/admin-device-assignment-api.json)；验收测试：[admin-device-assignment.test.ts](../apps/cloud-api/test/admin-device-assignment.test.ts)（9 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DEV-02（P1 / 管理后台后端），依赖 BE-DEV-01、DOM-01、DOM-03（均已交付） |
| 生命周期 | DOM-01 迁移表为唯一事实源：仅 Onboarded/Assigned 允许分配；首次分配 Onboarded→Assigned 经 `transitionLifecycle`（该迁移仅 PlatformSuperAdmin，Operator 触发领域层 403） |
| 通知 | CT-04 notification-catalog：`ASSIGNMENT_CHANGED`（deviceAction=SYNC），经 Outbox 下发（投递由下行分发器负责，本任务不直接发布 MQTT） |
| 功能边界 | 不自动创建 License（BE-LIC 任务）；不做设备端同步执行 |

## 2. 端点与语义

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/devices/{deviceId}/assignment` | `device:assign`（SuperAdmin/Operator） | 分配/调整 Customer 和 Site；审计 `device.assignment.assign` |
| `GET /api/v1/admin/devices/{deviceId}/assignments` | `device:read` | Assignment 历史（授权窗口），assignedAt 倒序，上限 50；Customer 角色仅本 Customer 设备 |

规则：

- **Authorization Window / 历史**：`device_assignments` 每行即一段授权窗口 `[assignedAt, endedAt)`；再分配闭合当前 ACTIVE 行（ENDED + endedAt）并开启新行；部分唯一索引保证每设备至多一条 ACTIVE；
- **幂等**：目标 customerId+siteId 与当前 ACTIVE 一致 → `replayed=true`、`notification=null`，无写入/通知/审计；并发首次分配撞唯一索引 → 回读胜出记录，同目标重放、异目标 409 CONFLICT；
- **并发状态保护**：设备归属更新携带生命周期条件（Onboarded/Assigned），并发状态变更 → 409；
- **通知**：每次真实变更恰好一个 Outbox 事件（topic `bnx/device/{id}/notification`，data `{type: ASSIGNMENT_CHANGED, action: SYNC}`）。

## 3. 验收基准与证据（vitest + PGlite，9 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 跨 Customer Site 被拒绝 | B 的 Site + A 的 customerId → 400 VALIDATION_FAILED；Customer/Site/设备不存在 → 404 | ✅ |
| 合法分配更新历史并生成一次通知 | 首次分配：Onboarded→Assigned + 状态历史 + 授权窗口 ACTIVE + Outbox 恰好 1 条 + SUCCESS 审计；再分配：旧窗口闭合、新窗口开启、Outbox 恰好 2 条（每次变更一条） | ✅ |
| 重复请求幂等 | 同目标再请求 → replayed=true、notification=null，分配行/通知/审计数量不变 | ✅ |
| 仅 Onboarded/Assigned 合法 | PendingOnboarding/Licensed/Active/Suspended/Retired → 409 DEVICE_STATE_NOT_ALLOWED | ✅ |
| 角色边界 | Operator 首次分配 → 403（DOM-01）且状态未变；Operator 再分配 → 200；Auditor/Customer → 403；未认证 → 401 | ✅ |
| 附加 | 历史接口 Customer 隔离（跨 Customer 403）；响应字段与 OpenAPI 封闭一致；错误码对齐 CT-05；无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-device-assignment-api.test.ts`（3 项）。

## 4. 未决风险

- 首次分配（Onboarded→Assigned）的 DOM-01 角色约束（仅 PlatformSuperAdmin）窄于 API 权限点 `device:assign`（含 PlatformOperator）：当前以领域层为准拒绝并返回 403；若产品确认 Operator 可首分配，需先调整 DOM-01 迁移表（状态机事实源），而非放宽本接口；
- ASSIGNMENT_CHANGED 的 MQTT 实际投递依赖下行分发器（Outbox Publisher 当前仅归档链路）；通知可达性由后续下行链路任务验证；
- 分配不触发设备端 SYNC 执行，仅通知；设备拉取差异由 Sync 接口（BE-SYNC）负责。
