# AUTH-02 Onboarding Token 认证

实现：[packages/auth/src/onboarding](../packages/auth/src/onboarding)；测试：[onboarding-token.test.ts](../packages/auth/test/onboarding-token.test.ts)、[rate-limit.test.ts](../packages/auth/test/rate-limit.test.ts)、[onboarding-guard.test.ts](../packages/auth/test/onboarding-guard.test.ts)（PGlite 真实 PostgreSQL + 实际 migration.sql）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | AUTH-02（P0 / 设备接口），依赖 DB-01、CT-05（均已交付） |
| 落点 | `@fdp/auth` 包 `onboarding/` 子模块（与 AUTH-01 Cognito 并列的第二种认证机制） |
| Token 规则 | 实施方案 8.2：一次一机、可撤销、有有效期、只存 Hash、限制每 Token/IP 频率 |
| 数据模型 | DB-01 `onboarding_tokens`（tokenHash 唯一、serialNumber、expiresAt/usedAt/revokedAt） |
| 功能边界 | 不实现管理员审批（BE-ONB-02）和证书签发（BE-ONB-03）；请求幂等返回由 BE-ONB-01 落地 |

## 2. 模块组成

| 模块 | 内容 |
|---|---|
| `token.ts` | 明文生成（`fdp_onb_` + 32B base64url）、SHA-256 散列、16hex 指纹（日志/审计唯一允许形态） |
| `repository.ts` | `issueOnboardingToken`（签发，校验设备库存序列号存在）、`findOnboardingTokenByHash`、`revokeOnboardingToken`（幂等）、`markOnboardingTokenUsed`（条件更新，并发安全） |
| `verifier.ts` | `verifyOnboardingToken` 校验链：格式 → 散列查找 → 撤销 → 核销 → 过期 → 序列号绑定；全部凭证失败 401（不区分原因防探测），缺序列号 400 |
| `rate-limit.ts` | 固定窗口限频：`RateLimitRule` + `RateLimitStore` 抽象 + 进程内实现；超限 429 `RATE_LIMITED` |
| `guard.ts` | `withOnboardingAuth` 中间件：限频（默认按 Token 指纹，先于 DB 查询）→ 校验 → Handler 注入 `OnboardingAuthContext` |

配套变更：`@fdp/auth` 的 `AuthErrorCode` 扩展 `RATE_LIMITED`(429)、`VALIDATION_FAILED`(400)；`@fdp/database` 导出 `PrismaClient` 值（测试/Worker 以适配器构造客户端）。

## 3. 验收基准与证据（vitest，auth 包 44 项含 AUTH-01）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 错误 Token 拒绝 | 未签发/畸形/非 Bearer → 401 | ✅ |
| 过期 Token 拒绝 | `expiresAt` 过去 + 注入时钟 → 401 | ✅ |
| 撤销 Token 拒绝 | revoke 后 verify → 401；重复撤销幂等 false | ✅ |
| 跨序列号拒绝 | SN-BIND-A 的 Token 用于 SN-BIND-B → 401 | ✅ |
| 过量请求拒绝 | 限频 2 次后第 3 次 → 429，且先于 DB 校验 | ✅ |
| 数据库不出现明文 Token | 行序列化断言无明文，仅 `tokenHash` | ✅ |
| 日志只记录指纹 | ctx 仅暴露 16hex 指纹，断言指纹 ≠ 明文 | ✅ |
| 一次一机 | 签发校验库存序列号（不存在 → 400）；核销后 → 401；二次核销 false | ✅ |

`pnpm vitest run packages/auth/test` 44/44 通过；全仓 `pnpm verify` 退出 0（2026-08-27）。

## 4. 对接说明（下游任务）

- **BE-ONB-01**（request/status 端点）：`withOnboardingAuth({ client, tokenOf, serialNumberOf, rateLimiter }, handler)` 接线；重复提交幂等返回原 `requestId` 由 `onboarding_requests` 部分唯一索引实现（不在本任务）；
- **BE-ONB-03/04**：证书包领取成功后调用 `markOnboardingTokenUsed`（一次一机的"一次"核销点，DEC-003）；
- **管理员侧签发**：`issueOnboardingToken` 供制造/运营流程使用（当前无对外签发端点，属后续任务或运维流程）。

## 5. 未决风险

- 限频 V1 为进程内固定窗口：Lambda 多实例并发时计数不共享（各实例独立计数，限频放宽为 实例数×limit）；全局一致限频可平滑替换 `RateLimitStore` 为 DynamoDB/ElastiCache 实现，接口不变；
- Token 签发无对外端点（任务边界），试运营期由运维/制造流程在受控环境调用；
- `usedAt` 核销依赖 BE-ONB-03/04 在正确时机调用；若漏调用，Token 在有效期内可重复查询 status（设计允许），但无法重复发证（证书包一次性领取由 DEC-003 策略拦截）。
