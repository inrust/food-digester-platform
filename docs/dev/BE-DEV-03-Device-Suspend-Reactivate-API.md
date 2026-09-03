# BE-DEV-03 Device Suspend/Reactivate API

实现：[apps/cloud-api/src/admin/device-status](../apps/cloud-api/src/admin/device-status/index.ts)；OpenAPI：[contracts/rest/admin-device-status-api.json](../contracts/rest/admin-device-status-api.json)；验收测试：[admin-device-status.test.ts](../apps/cloud-api/test/admin-device-status.test.ts)（8 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DEV-03（P1 / 管理后台后端），依赖 BE-DEV-01、DOM-01、DOM-03（均已交付） |
| 状态机 | DOM-01 迁移表为唯一事实源：Active→Suspended（ADMIN + SuperAdmin/Operator + 强制原因，operational 镜像 Suspended）；Suspended→Active（强制原因 + `issueResolvedApproved`） |
| 通知 | CT-04 notification-catalog：挂起 `DEVICE_SUSPENDED`、恢复 `STATUS_CHANGED`（deviceAction=SYNC），经 Outbox 下行（本任务不直接发布 MQTT） |
| 功能边界 | 不执行设备端模式切换（无 cmd 下发，仅通知；设备拉取差异由 Sync 负责） |

## 2. 端点与语义

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/devices/{deviceId}/suspend` | `device:write` | Active→Suspended；reason 必填；审计 `device.suspend` |
| `POST /api/v1/admin/devices/{deviceId}/reactivate` | `device:write` | Suspended→Active；reason + `issueResolved=true` 必填；批准人（调用者）与原因写审计 `device.reactivate` |

- **幂等**：已处于目标状态的重复请求 → `replayed=true`、`notification=null`，不产生写入/通知/审计；
- **并发**：生命周期条件更新兜底（状态漂移 → 409 CONFLICT）；
- **镜像**：DOM-01 operationalMirror 产出的 lifecycle + operational 两条状态历史同事务落库；`device_latest_state.operationalStatus` 为设备上报口径（Heartbeat 维护），本服务不写（与 BE-IOT-07 一致）；
- **审计**：DOM-03 `audited`——SUCCESS 与业务同事务、失败回滚后独立记 FAILURE；reactivate 的 afterValue 含 `issueResolved: true` 与 `approvedBy`。

## 3. 验收基准与证据（vitest + PGlite，8 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 非法状态转换失败 | 非 Active 挂起 / 非 Suspended 恢复 → 409 DEVICE_STATE_NOT_ALLOWED | ✅ |
| 原因和审批写审计 | suspend reason 入审计/状态历史；reactivate 审计含 reason + issueResolved + approvedBy | ✅ |
| 重复请求不重复通知 | 重复挂起/恢复 → replayed，Outbox/状态历史/审计数量不变 | ✅ |
| 通知类型正确 | 挂起恰好 1 条 DEVICE_SUSPENDED、恢复恰好 1 条 STATUS_CHANGED（topic bnx/device/{id}/notification，action SYNC） | ✅ |
| 不执行设备端模式切换 | 断言无 cmd/其他类型 Outbox 事件 | ✅ |
| 附加 | 缺原因/issueResolved 非 true → 400；404/401/403（Auditor、Customer 角色）；响应字段与 OpenAPI 封闭一致；错误码对齐 CT-05；无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-device-status-api.test.ts`（3 项）。

## 4. 未决风险

- operational 镜像只落状态历史、不回写 `device_latest_state.operationalStatus`（设备上报口径由 Heartbeat 维护）：Suspended 设备的台账 Operational 展示以生命周期轴为准；若产品要求 Operational 轴立即镜像，需先明确 DEC-010 四轴写方归属再扩展；
- 通知实际投递依赖下行分发器（当前 Outbox 仅归档链路）；
- "管理员批准"由持有 `device:write` 的调用者身份承担（单级批准）；如需四级审批流，需新任务定义审批模型。
