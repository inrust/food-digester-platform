# BE-DEV-04 Device Retirement 工作流

实现：[apps/cloud-api/src/admin/device-retirement](../../apps/cloud-api/src/admin/device-retirement/index.ts)；OpenAPI：[contracts/rest/admin-device-retirement-api.json](../../contracts/rest/admin-device-retirement-api.json)；验收测试：[admin-device-retirement.test.ts](../../apps/cloud-api/test/admin-device-retirement.test.ts)与[超时测试](../../apps/cloud-api/test/device-retirement-timeout.test.ts)（PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DEV-04（P1 / 管理后台后端），依赖 BE-DEV-01、DOM-01、BE-SYNC-02、DOM-03（均已交付） |
| 状态机 | DOM-01 迁移表为唯一事实源：仅 Active/Suspended→Retired，仅 PlatformSuperAdmin，强制原因，operational 镜像 Retired；Retired 无出边（永久不可恢复） |
| 退役记录 | `device_retirements`（BE-SYNC-02 建表）：retire 创建 PENDING_CONFIRMATION；设备 deactivate（BE-SYNC-02）或本任务 force-complete 置 CONFIRMED 并完成证书停用 |
| DEC-014 实现 | 72 小时窗口已落地：Retired 默认拒绝，仅 Sync/Deactivate 限时可达；超时评估器自动完成、撤证并审计 `UNCONFIRMED_TIMEOUT` |

## 2. 端点与工作流

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/devices/{deviceId}/retire` | `device:write`（DOM-01 迁移仅 SuperAdmin） | reason + `confirm=true` 强制；事务内：生命周期迁移 + Assignment ACTIVE→ENDED + License 非终态→Revoked + Entitlement 停用 + PENDING_CONFIRMATION 记录 + DEVICE_RETIRED Outbox；**证书保持 ACTIVE** |
| `POST /api/v1/admin/devices/{deviceId}/retire/complete` | `device:write` | force-complete：reason 强制；仅 Retired + 待确认可执行；与 BE-SYNC-02 共享 `completeRetirementStep`（CONFIRMED/FORCE_COMPLETE + 撤销 ACTIVE 证书）；审计 `device.retire.force_complete` |

内部 `evaluateRetirementTimeouts` 以 `initiatedAt+72h` 为截止点批量扫描。精确边界纳入处理；每个候选在事务内条件完成并撤销 ACTIVE 证书，只有胜出者写入一次 `device.retire.timeout` SUCCESS 审计，`reason/completionMethod` 均为 `UNCONFIRMED_TIMEOUT`。重复调度或与设备确认/人工强制并发时，失败竞争者无审计、无重复撤证。

**顺序约束**（验收基准）：retire 不断证 → 设备凭 ACTIVE 证书调用 BE-SYNC-02 deactivate 确认 → 确认同事务完成断证。反向（先断证）会导致设备永远无法确认，由该顺序保证不发生。

**幂等**：已 Retired + 记录存在 → retire 重放（不重复通知）；已 CONFIRMED → force-complete 重放（不重复审计）；并发由生命周期/退役记录条件更新兜底（409）。

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 顺序正确，不能先断证导致设备无法确认 | 跨模块集成：retire 后证书 ACTIVE → 设备 deactivate 200 确认 → 断证；Retired 的普通接入仍为 403 | ✅ |
| 退役后业务命令全部拒绝 | Retired 后 suspend 409、assign 409、设备端 verifyDeviceCertificate 403 | ✅ |
| 仅 Active/Suspended→Retired；永久不可恢复 | 其余 4 种生命周期 409；Retired 无记录 409 CONFLICT；Retired 无出边由 DOM-01 表保证 | ✅ |
| 强制原因和确认 | 缺 reason/confirm 非 true → 400；Operator 退役 403（DOM-01 仅 SuperAdmin）；Auditor 403；未认证 401 | ✅ |
| 撤销 Assignment/Entitlement/License + DEVICE_RETIRED + 待确认记录 | 窗口闭合 ENDED、License Revoked、Entitlement enabled=false、PENDING_CONFIRMATION、Outbox 恰好 1 条、审计 SUCCESS | ✅ |
| force-complete 领域接口和审计 | 离线强制完成：CONFIRMED/FORCE_COMPLETE + 断证 + 审计；重复幂等；非法上下文 409/404/400 | ✅ |
| DEC-014 认证窗口 | 通用设备接入默认拒绝 Retired；仅待确认且 72h 内的 Sync 放行；精确边界 fail closed；Deactivate 保持专用确认/重放通道 | ✅ |
| DEC-014 超时完成 | 72h 前不处理；精确边界 CONFIRMED/UNCONFIRMED_TIMEOUT + 撤证 + 单次稳定审计；重复调度零副作用 | ✅ |
| 附加 | 重复 retire 不重复通知；响应字段与 OpenAPI 封闭一致；错误码对齐 CT-05；无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-device-retirement-api.test.ts`（3 项）。

## 4. 接线边界与风险

- force-complete 权限为 `device:write`（SuperAdmin/Operator 均可），任务未指定更严角色；如需 SuperAdmin 限定，一处权限点调整即可；
- DEVICE_RETIRED 通知的实际 MQTT 投递依赖下行分发器（Outbox 当前仅归档链路）；
- `evaluateRetirementTimeouts` 已提供可重复调用的领域入口；生产调度频率、告警和运行凭据属于部署接线，不在本仓库框架无关 Service 内硬编码；
- 应用层已阻断超时后的 Sync，因此调度短暂延迟不会延长临时认证能力；超时完成本身将在下一次调度执行。
