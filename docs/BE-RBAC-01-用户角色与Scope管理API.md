# BE-RBAC-01 用户、角色和 Scope 管理 API

实现：[apps/cloud-api/src/admin/user](../apps/cloud-api/src/admin/user)（errors/cognito-port/service/handler）；REST 契约 [admin-user-api.json](../contracts/rest/admin-user-api.json)；角色种子 [migration 20260905130000](../packages/database/prisma/migrations/20260905130000_seed_rbac_roles/migration.sql)；验收测试 [admin-user.test.ts](../apps/cloud-api/test/admin-user.test.ts)（13 项，PGlite）。

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

**越权防护**：自我操作拒绝（目标 `cognitoSub === actor.actorId` 时角色变更/停用 → 403）；Customer actor 不得授权平台角色、不得跨 Customer（服务层双重防护，矩阵层已 403）；最后一个非停用 PlatformSuperAdmin 不可被移除角色或停用（→ 409）。

**Cognito 同步先行**（[CognitoAdminPort](../apps/cloud-api/src/admin/user/cognito-port.ts)，注入式无 AWS 依赖）：inviteUser（AdminCreateUser，临时凭证由 Cognito 生成并发送）→ setUserGroups（Groups 整体替换）→ setUserCustomerScope（`custom:customer_id`）→ disableUser → triggerPasswordReset（AdminResetUserPassword）。Cognito 失败不产生 DB 变化；DB 失败留下 Cognito 漂移（已知运维风险，见 §4）。**API 不接收永久密码，响应不含任何凭证材料**（PasswordResetResult 仅 `{userId, status: RESET_TRIGGERED}`；UserView 不含 cognitoSub/密码字段，契约测试强制）。

**审计（DOM-03）**：`user.invite` / `user.role.assign` / `user.scope.change` / `user.disable` / `user.password_reset.trigger` 经 `audited` 同事务写入（before/after 值齐备）。

## 3. 验收基准与证据（vitest + PGlite，13 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 自我提权拒绝 | 目标 cognitoSub === actor.actorId 时角色变更/停用 → 403，Cognito 零调用、角色未变化 | ✅ |
| 跨 Customer 授权拒绝 | Customer actor 跨 Customer 邀请/改 scope → FORBIDDEN；CustomerAdmin 用户提升平台角色 → 403 | ✅ |
| 最后一个 SuperAdmin 保护 | 移除角色/停用唯一非停用 SuperAdmin → 409；新增可用 SuperAdmin 后放行 | ✅ |
| 邀请/重置无密码材料 | 响应 JSON 无 password/hash/cognitoSub；重置响应仅 `{userId,status}`；契约测试禁止 UserInvite 含 password 字段 | ✅ |
| PlatformOperator 权限边界 | Operator/CustomerAdmin 调 user:write → 403；Operator 调 user:read 列表 → 403；无 actor → 401 | ✅ |
| 角色集与 scope 校验 | 混绑/未知/空角色、平台角色带 customerId、Customer 角色缺 customerId → 400；重复 email → 409；Customer 不存在 → 404 / 非 ACTIVE → 409；校验失败零 Cognito 调用 | ✅ |
| Cognito 同步 | invite/groups/scope/disable/reset 端口调用参数断言（groups 去重、customerId 传递） | ✅ |
| 审计齐备 | 5 个 action 均落 audit_logs（含 before/after） | ✅ |
| 列表 | roleType/status/customerId/q 筛选 + 键集游标分页；视图不泄露 cognitoSub；非法筛选 → 400 | ✅ |
| 停用幂等 | 重复 disable → 200 回放，无重复 Cognito 调用/审计 | ✅ |

## 4. 未决风险

- **Cognito adapter 为端口定义**：AdminCreateUser/AdminAddUserToGroup/AdminUpdateUserAttributes/AdminDisableUser/AdminResetUserPassword 的 AWS 实现由部署层接线（IAC-01 User Pool 已备）。
- **Cognito↔DB 漂移**：Cognito 先行成功后 DB 失败会留下漂移（Cognito 已建用户、DB 无记录）；当前以审计失败记录 + 运维对账兜底，未实现补偿事务（saga）。
- **MFA 客服重置与人工账号恢复**：明确超出本任务功能边界，需另立任务与运营流程。
- **Customer actor 服务层防护为纵深防御**：V1 矩阵中 Customer 角色无 user:write（DEC-012 固定只读），服务层跨 Customer/平台角色守卫在矩阵扩展前不经 HTTP 触达，由直接服务调用测试覆盖。
