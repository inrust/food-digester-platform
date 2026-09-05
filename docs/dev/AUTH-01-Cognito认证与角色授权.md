# AUTH-01 Cognito JWT 认证与角色授权

实现：[packages/auth/src](../../packages/auth/src/index.ts)；测试：[packages/auth/test](../../packages/auth/test)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | AUTH-01（P0 / 管理后台后端），依赖 CT-05、DB-02、IAC-01（均已交付） |
| 形态 | 框架无关的 `@fdp/auth` 包；Guard/Decorator 为纯函数 + HOF；管理 API Lambda 组合根已执行 JWT 验签并构造可信 ActorContext |
| 角色事实源 | Cognito User Pool Group（IAC-01 创建同名 5 组）+ DEC-012 封闭映射 + 实施方案 §12.1 角色表 |
| 错误码事实源 | CT-05 `contracts/rest/error-codes.json`（401 `UNAUTHENTICATED` / 403 `FORBIDDEN`），一致性由测试锁定 |
| 功能边界 | 不实现 Cognito 账号运维和 MFA 策略配置页面（运维/FE 任务） |

## 2. 模块组成

| 模块 | 内容 |
|---|---|
| `cognito.ts` | 认证 Guard：`createCognitoAuthenticator(config).authenticate(authorizationHeader)` — RS256 签名（JWKS）+ issuer + token_use + client 绑定（ID Token 用 `aud`、Access Token 用 `client_id`）；`cognito:groups` → 角色，`custom:customer_id` → Customer scope |
| `roles.ts` | 封闭角色集（3 平台 + 2 Customer）、`ActorContext`（actorId/username/actorType/roles/customerId/tokenUse） |
| `permissions.ts` | 集中式权限矩阵 `PERMISSION_MATRIX`：34 个权限点 × 5 角色（V1 固定，DEC-012） |
| `guard.ts` | 授权 Guard/Decorator：`requirePermission`（越权 403）、`assertCustomerScope`（跨 Customer 403）、`withAuthorization`（路由装饰器：身份 → 权限点 → Customer scope 顺序校验） |
| `errors.ts` | `AuthError`（code + httpStatus），消息对外安全，401 不区分过期/伪造/缺失（防探测） |

失败关闭规则：未知 Cognito 组、空组、平台/Customer 角色混绑、Customer 角色缺 `custom:customer_id` → 403；平台角色的 `customerId` 恒为 `null`（忽略 Token 声明，服务端为唯一可信来源）。

## 3. 权限矩阵要点（V1）

| 角色 | 权限概要 |
|---|---|
| PlatformSuperAdmin | 全部 34 权限点 |
| PlatformOperator | 客户/站点/设备/许可证/OTA/命令/重放操作；**无**合约写、角色、用户、设置、审批、导出、审计权限（BE-RBAC-01 验收约束） |
| Auditor | 全部 `:read` + `audit:read` + `export:create`，零写权限 |
| CustomerAdmin | Customer 域：设备用户读写、数据只读、`command:send`、`export:create` |
| CustomerViewer | Customer 域只读（不含导出） |

矩阵仅表达产品 API 级权限，不授予任何 AWS 账号资源权限（DEC-012）。

## 4. 验收基准与证据（vitest）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 过期 Token → 401 | `过期 Token → 401`（exp 负值，clockTolerance=0） | ✅ |
| 伪造 Token → 401 | `伪造签名（另一密钥对）→ 401`，另覆盖错误 issuer/aud/client_id、缺失/畸形/非 Bearer | ✅ |
| 角色越权 → 403 | `requirePermission`（Auditor 写、Customer 用平台域权限）、`withAuthorization` 权限不足不进 Handler | ✅ |
| Customer A 无法读改 Customer B | `assertCustomerScope` 跨 Customer 403 + Decorator 级 `customerOf` 校验（自身放行、platform 放行） | ✅ |
| 角色矩阵集中定义 | 矩阵键=封闭角色集、无死权限、各角色边界断言（Operator/Auditor/CustomerAdmin/CustomerViewer） | ✅ |
| 401/403 与 CT-05 一致 | `contract-parity.test.ts` 读 error-codes.json 比对 | ✅ |
| 认证失败不泄露原因 | 断言错误消息不含 signature/issuer/expired 等内部细节 | ✅ |

当前证据命令：`pnpm --filter @fdp/auth typecheck`、`pnpm vitest run packages/auth/test`、`pnpm verify`。精确测试快照记录在 `docs/audit`，任务文档不固化易漂移计数。

## 5. 对接说明（下游任务）

- **BE-\***：`const actor = await authenticator.authenticate(headers.authorization)`，随后 `runWithContext({ requestId, actorId: actor.actorId, actorRole: actor.roles[0], customerId: actor.customerId ?? undefined }, ...)` 接入 DB-02 审计上下文；路由用 `withAuthorization({ permission, customerOf }, handler)` 包装；
- **IAC-01**：API Lambda 环境变量已含 `USER_POOL_ID` / `USER_POOL_CLIENT_ID`，region 取 `AWS_REGION`；
- **BE-RBAC-01**：权限点表以 `PERMISSION_MATRIX` 为唯一事实源，禁止另建矩阵；
- **FE-01/FE-16**：角色集合与显示名只读消费，权限复选框只读（DEC-012）。

## 6. 未决风险

- JWKS 远程拉取在 Lambda 冷启动产生一次网络往返；`JWTVerifyGetKey` 带缓存，Node 进程复用后摊销，暂不引入额外缓存层；
- Cognito `cognito:groups` 变更依赖 Token 过期刷新生效（默认 1h）；如需即时吊销，由 BE-RBAC-01 结合停用流程处理；
- DEC-012 已冻结为 `1.0.0`：角色映射与 V1 只读权限矩阵不得脱离正式变更流程单独调整。
