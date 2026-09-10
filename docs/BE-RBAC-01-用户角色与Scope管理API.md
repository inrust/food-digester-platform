# BE-RBAC-01 用户、角色和 Scope 管理 API

实现：[apps/cloud-api/src/admin/user](../apps/cloud-api/src/admin/user)（errors/cognito-port/service/handler）及 [Cognito AWS adapter](../packages/aws-clients/src/cognito-admin.ts)；REST 契约 [admin-user-api.json](../contracts/rest/admin-user-api.json)；角色种子 [migration 20260905130000](../packages/database/prisma/migrations/20260905130000_seed_rbac_roles/migration.sql)；验收测试 [admin-user.test.ts](../apps/cloud-api/test/admin-user.test.ts)（PGlite）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-RBAC-01（P2 / 用户与权限），依赖 AUTH-01（角色模型 + V1 权限矩阵 + withAuthorization）、DOM-03（审计）、DEC-012@1.0.0（原型「平台管理员/运维人员」→ PlatformSuperAdmin/PlatformOperator，矩阵固定只读） |
| 事实源 | 实施方案 RBAC 章节；AUTH-01 运行时事实源：角色 ↔ Cognito User Pool Groups（`cognito:groups`）、Customer scope ↔ `custom:customer_id` |
| Schema 变更 | 无结构变更；`roles` 表补 5 角色种子（PlatformSuperAdmin/PlatformOperator/Auditor/CustomerAdmin/CustomerViewer，`user_roles` 外键依赖） |
| 功能边界 | 不负责 Cognito 租户运维、MFA 客服重置和人工账号恢复 |

## 2. 关键设计

**路由**（`apps/cloud-api/src/admin/user/handler.ts`，全部经 withAuthorization）：`GET /api/v1/admin/users`（user:read，筛选 roleType/status/customerId/q + 键集游标分页）；`POST /users`（邀请）、`PUT /users/{userId}/roles`（整体替换）、`PUT /users/{userId}/scope`、`POST /users/{userId}/disable`（幂等回放）、`POST /users/{userId}/password-reset`（均 user:write——V1 矩阵中仅 PlatformSuperAdmin 持有，PlatformOperator/CustomerAdmin → 403）。

**角色规则**：封闭集 5 角色；平台/Customer 角色禁止混绑（单一 actorType）；平台角色恒无 Customer scope（带 customerId → 400）；Customer 角色必须有可用 Customer（ACTIVE 且未软删除）；角色类型创建后不可变（customer → platform 提升 → 403）；平台角色变更服务层双重校验仅 SuperAdmin。

**越权防护**：自我操作拒绝（目标 `cognitoSub === actor.actorId` 时角色变更/停用 → 403）；Customer actor 不得授权平台角色、不得跨 Customer（服务层双重防护，矩阵层已 403）；角色变更/停用事务先锁定 `roles.PlatformSuperAdmin` 行，再复核有效 SuperAdmin 基数，互相降级或停用/降级并发只能成功一个。

**Cognito 一致性闭环**：每次外部变更前先持久化 `COGNITO_ADMIN_RECONCILIATION` 意图；Groups/Scope/Disable 在受审计事务内调用，后续 DB 失败时恢复旧 Groups/Scope 或重新 Enable，邀请失败删除已创建用户。调用结果不确定、补偿失败或不可逆密码重置的提交状态不确定时，意图保持 PENDING，并写 `user.cognito.reconciliation_required` 失败审计供告警/对账。生产 adapter 实现 AdminCreate/Delete/Enable/Disable、组整体同步、Customer 属性和 Reset，IAM 限定当前 User Pool。**API 不接收永久密码，响应不含任何凭证材料**。

**审计（DOM-03）**：`user.invite` / `user.role.assign` / `user.scope.change` / `user.disable` / `user.password_reset.trigger` 经 `audited` 同事务写入（before/after 值齐备）。

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 自我提权拒绝 | 目标 cognitoSub === actor.actorId 时角色变更/停用 → 403，Cognito 零调用、角色未变化 | ✅ |
| 跨 Customer 授权拒绝 | Customer actor 跨 Customer 邀请/改 scope → FORBIDDEN；CustomerAdmin 用户提升平台角色 → 403 | ✅ |
| 最后一个 SuperAdmin 保护 | 移除角色/停用唯一非停用 SuperAdmin → 409；新增可用 SuperAdmin 后放行 | ✅ |
| SuperAdmin 并发保护 | 两个仅存 SuperAdmin 互相降级、停用与降级竞争均仅一个成功，最终至少保留一个有效 SuperAdmin | ✅ |
| 邀请/重置无密码材料 | 响应 JSON 无 password/hash/cognitoSub；重置响应仅 `{userId,status}`；契约测试禁止 UserInvite 含 password 字段 | ✅ |
| PlatformOperator 权限边界 | Operator/CustomerAdmin 调 user:write → 403；Operator 调 user:read 列表 → 403；无 actor → 401 | ✅ |
| 角色集与 scope 校验 | 混绑/未知/空角色、平台角色带 customerId、Customer 角色缺 customerId → 400；重复 email → 409；Customer 不存在 → 404 / 非 ACTIVE → 409；校验失败零 Cognito 调用 | ✅ |
| Cognito 同步 | invite/groups/scope/disable/reset 端口调用参数断言（groups 去重、customerId 传递） | ✅ |
| Cognito/DB 恢复 | Cognito 已生效而 DB 写失败时恢复旧 Groups；结果不确定时保留 PENDING 对账意图并写失败审计 | ✅ |
| 审计齐备 | 5 个 action 均落 audit_logs（含 before/after） | ✅ |
| 列表 | roleType/status/customerId/q 筛选 + 键集游标分页；视图不泄露 cognitoSub；非法筛选 → 400 | ✅ |
| 停用幂等 | 重复 disable → 200 回放，无重复 Cognito 调用/审计 | ✅ |

## 4. 未决风险

- **Cognito 与数据库不能构成单一 ACID 事务**：已用持久化意图、确定性补偿和失败审计关闭静默漂移；目标 AWS 仍需验证超时/断连后的 PENDING 对账告警流程。
- **MFA 客服重置与人工账号恢复**：明确超出本任务功能边界，需另立任务与运营流程。
- **Customer actor 服务层防护为纵深防御**：V1 矩阵中 Customer 角色无 user:write（DEC-012 固定只读），服务层跨 Customer/平台角色守卫在矩阵扩展前不经 HTTP 触达，由直接服务调用测试覆盖。

## 5. 状态边界与发布 Gate

- `module implemented`：严格请求解析、并发不变量、补偿/对账、契约与本地回归已实现。
- `production wired`：Admin Router、Lambda、Cognito adapter 与最小 IAM 已接线。
- `target verified`：**NOT RUN**；真实 Cognito 超时、补偿与 RDS 并发仍需目标环境回执。
- 本地统一验证：`pnpm verify`。历史审计快照：[BE-MED-RBAC-AUD-DASH-SET 全面复盘检查报告](audit/BE-MED-RBAC-AUD-DASH-SET全面复盘检查报告-2026-09-09.md)。
- 发布证据：[BE-MED/RBAC/AUD/DASH/SET AWS 验收证据采集说明](audit/evidence/BE-MED-RBAC-AUD-DASH-SET-AWS验收证据采集说明.md)，执行 `pnpm check:aws-med-rbac-aud-dash-set-evidence`。
