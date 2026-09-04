# BE-DEV-04 Device Retirement 工作流

实现：[apps/cloud-api/src/admin/device-retirement](../apps/cloud-api/src/admin/device-retirement/index.ts)；OpenAPI：[contracts/rest/admin-device-retirement-api.json](../contracts/rest/admin-device-retirement-api.json)；验收测试：[admin-device-retirement.test.ts](../apps/cloud-api/test/admin-device-retirement.test.ts)（7 项，PGlite 真实 PostgreSQL，含与 BE-SYNC-02 的跨模块顺序集成）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DEV-04（P1 / 管理后台后端），依赖 BE-DEV-01、DOM-01、BE-SYNC-02、DOM-03（均已交付） |
| 状态机 | DOM-01 迁移表为唯一事实源：仅 Active/Suspended→Retired，仅 PlatformSuperAdmin，强制原因，operational 镜像 Retired；Retired 无出边（永久不可恢复） |
| 退役记录 | `device_retirements`（BE-SYNC-02 建表）：retire 创建 PENDING_CONFIRMATION；设备 deactivate（BE-SYNC-02）或本任务 force-complete 置 CONFIRMED 并完成证书停用 |
| 当前实现差距 | DEC-014@1.0.0 已冻结 72 小时自动强制完成；现有代码只有人工 force-complete 领域接口，尚缺超时评估器、调度接线和 `UNCONFIRMED_TIMEOUT` 审计 |

## 2. 端点与工作流

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/devices/{deviceId}/retire` | `device:write`（DOM-01 迁移仅 SuperAdmin） | reason + `confirm=true` 强制；事务内：生命周期迁移 + Assignment ACTIVE→ENDED + License 非终态→Revoked + Entitlement 停用 + PENDING_CONFIRMATION 记录 + DEVICE_RETIRED Outbox；**证书保持 ACTIVE** |
| `POST /api/v1/admin/devices/{deviceId}/retire/complete` | `device:write` | force-complete：reason 强制；仅 Retired + 待确认可执行；与 BE-SYNC-02 共享 `completeRetirementStep`（CONFIRMED/FORCE_COMPLETE + 撤销 ACTIVE 证书）；审计 `device.retire.force_complete` |

**顺序约束**（验收基准）：retire 不断证 → 设备凭 ACTIVE 证书调用 BE-SYNC-02 deactivate 确认 → 确认同事务完成断证。反向（先断证）会导致设备永远无法确认，由该顺序保证不发生。

**幂等**：已 Retired + 记录存在 → retire 重放（不重复通知）；已 CONFIRMED → force-complete 重放（不重复审计）；并发由生命周期/退役记录条件更新兜底（409）。

## 3. 验收基准与证据（vitest + PGlite，7 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 顺序正确，不能先断证导致设备无法确认 | 跨模块集成：retire 后证书 ACTIVE → 设备 deactivate 200 确认 → 断证；AUTH-03 通用接入在 Retired 后即 403 | ✅ |
| 退役后业务命令全部拒绝 | Retired 后 suspend 409、assign 409、设备端 verifyDeviceCertificate 403 | ✅ |
| 仅 Active/Suspended→Retired；永久不可恢复 | 其余 4 种生命周期 409；Retired 无记录 409 CONFLICT；Retired 无出边由 DOM-01 表保证 | ✅ |
| 强制原因和确认 | 缺 reason/confirm 非 true → 400；Operator 退役 403（DOM-01 仅 SuperAdmin）；Auditor 403；未认证 401 | ✅ |
| 撤销 Assignment/Entitlement/License + DEVICE_RETIRED + 待确认记录 | 窗口闭合 ENDED、License Revoked、Entitlement enabled=false、PENDING_CONFIRMATION、Outbox 恰好 1 条、审计 SUCCESS | ✅ |
| force-complete 领域接口和审计 | 离线强制完成：CONFIRMED/FORCE_COMPLETE + 断证 + 审计；重复幂等；非法上下文 409/404/400 | ✅ |
| 附加 | 重复 retire 不重复通知；响应字段与 OpenAPI 封闭一致；错误码对齐 CT-05；无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-device-retirement-api.test.ts`（3 项）。

## 4. 待实现项与风险

- force-complete 权限为 `device:write`（SuperAdmin/Operator 均可），任务未指定更严角色；如需 SuperAdmin 限定，一处权限点调整即可；
- DEVICE_RETIRED 通知的实际 MQTT 投递依赖下行分发器（Outbox 当前仅归档链路）；
- 实现以 `initiatedAt+72h` 为截止点的可重复执行超时评估器，并处理与设备 Deactivate/人工 force-complete 的并发；
- 超时路径必须记录 `UNCONFIRMED_TIMEOUT`，且不得重复撤证或重复产生业务副作用。
