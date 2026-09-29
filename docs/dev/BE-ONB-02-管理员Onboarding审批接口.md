# BE-ONB-02 管理员 Onboarding 审批接口

实现：[apps/cloud-api/src/admin/onboarding](../../apps/cloud-api/src/admin/onboarding)；契约：[contracts/rest/admin-onboarding-api.json](../../contracts/rest/admin-onboarding-api.json)；测试：[admin-onboarding.test.ts](../../apps/cloud-api/test/admin-onboarding.test.ts)（PGlite 真实 PostgreSQL + 全部 migration）、[admin-onboarding-parity.test.ts](../../apps/cloud-api/test/admin-onboarding-parity.test.ts)、[admin-onboarding-api.test.ts](../../contracts/rest/admin-onboarding-api.test.ts)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ONB-02（P1 / 管理后台后端），依赖 BE-ONB-01、AUTH-01、DOM-01、DOM-03（均已交付） |
| 端点 | `GET /api/v1/admin/onboarding/requests`（列表，默认 PENDING）、`GET .../{requestId}`（详情）、`POST .../{requestId}/approve`、`POST .../{requestId}/reject` |
| 认证/授权 | Cognito JWT（AUTH-01）；列表/详情需 `onboarding:read`（SuperAdmin/Operator/Auditor），审批需 `onboarding:approve`（权限矩阵中仅 PlatformSuperAdmin 持有） |
| 并发控制 | `If-Match` 乐观锁：`onboarding_requests.version`（本任务新增列与 migration）；条件更新 `(id, status='PENDING', version)` 保证并发/重复审批最多一个成功 |
| 生命周期 | DOM-01：approve → 设备 PendingOnboarding → OnboardingApproved；reject → Rejected（强制原因）；状态历史落库 |
| 审计 | DOM-03 `audited()`：业务写入 + SUCCESS 审计同事务；失败独立记 FAILURE；前后状态入审计，token 类字段自动脱敏 |
| 功能边界 | approve 在审批事务内创建持久化 Provisioning Job，由 BE-ONB-03 Worker 异步消费；不返回私钥，响应 DTO 不含 CSR 原文 |

## 2. 模块组成

| 模块 | 内容 |
|---|---|
| `errors.ts` | `AdminOnboardingError`：VALIDATION_FAILED(400)/NOT_FOUND(404)/CONFLICT(409)/VERSION_CONFLICT(409)/INTERNAL_ERROR(500)，与 CT-05 目录一致（parity 测试强制） |
| `repository.ts` | 键集游标分页列表；状态过滤封闭为 PENDING/APPROVED/REJECTED/TIMED_OUT；`reviewOnboardingRequestWithVersion` 条件更新；`toDto` 序列化（不含 CSR 原文） |
| `service.ts` | 审批链：reject 强制原因 → 事务内申请存在 → 设备资料一致性校验 → DOM-01 迁移 → 条件更新 → 设备状态/历史落库；approve 同事务创建 Provisioning Job |
| `handler.ts` | 框架无关 Handler：`withAuthorization` 权限门禁、If-Match 解析（语义同 CT-05 `parseIfMatch`）、CT-05 响应形态、错误映射（AuthError/AdminOnboardingError/DB 游标错误 → 400，其余 500 通用消息） |

配套变更：`onboarding_requests` 新增 `version` 列（migration `20260827160000_onboarding_request_review_version`）；`@fdp/database` `AuditedOperation` 增加显式 `actorId/actorRole`（优先于 AsyncLocalStorage 上下文）；测试辅助 `test/helpers.ts` 按序应用全部 migration。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 非授权角色 403 | PlatformOperator/Auditor/CustomerAdmin approve → 403 FORBIDDEN；未认证 → 401；Operator/Auditor 列表/详情可读 | ✅ |
| 并发审批只有一个成功 | 同版本 approve+reject 并发 → 恰一个 200、一个 409；version 仅 +1；SUCCESS 审计仅一条 | ✅ |
| If-Match 防重复审批 | 缺 Header/非法 → 400；版本不符 → 409 VERSION_CONFLICT；重复审批 → 409 CONFLICT | ✅ |
| Rejected 原因可查询 | reject 后详情与列表（status=REJECTED）均返回 rejectReason | ✅ |
| 审计含前后状态且不含 CSR 私钥材料 | audit_logs：before `{status:PENDING,version:1}` / after `{status:REJECTED,version:2,rejectReason}`；actorRole=PlatformSuperAdmin；全文无 CSR 正文或私钥材料 | ✅ |
| 审批校验设备资料 | 申请与库存不一致 → 409 CONFLICT，申请保持 PENDING；失败记 FAILURE 审计不伪造成功 | ✅ |
| approve 不返回私钥 | 响应体扫描无 privateKey/certificatePem；审批事务只写持久化 Provisioning Job | ✅ |
| 管理状态契约 | 非法 status → 400；TIMED_OUT 可经列表/详情查询且 OpenAPI 引用 DEC-017 | ✅ |
| 严格请求体 | reject 对未知字段执行 `additionalProperties:false` 等价校验并返回 400 | ✅ |

## 4. 交付状态（2026-09-07）

| 维度 | 状态 | 说明 |
|---|---|---|
| 模块验证 | PASS | RBAC、If-Match、并发审批、严格请求体、TIMED_OUT 展示、审计与 Job 原子写入均有测试 |
| 生产接线 | PASS（代码/IaC） | Cognito 管理路由已接入真实 Lambda；审批不再依赖进程内触发器 |
| 严格验收 | PASS（本地） | 2026-09-07 `pnpm verify` 退出 0：实现 986/986、契约 285/285、脚本 80/80；历史快照：2026-08-27 曾记录模块 28/28，仅作时点证据 |

## 5. 对接说明（下游任务）

- **BE-ONB-03**（证书签发）：独立 Worker 认领审批事务创建的 Provisioning Job，执行幂等签发与退避重试；状态查询走 `GET /api/v1/device/onboarding/status`；
- **FE 管理台**：列表/详情 DTO 携带 `version`，审批请求必须带 `If-Match: <version>`；409 响应需提示刷新后重试；
- **运行时接线**：适配层（API Gateway/Lambda）先用 AUTH-01 `createCognitoAuthenticator` 校验 JWT 并注入 `actor`，再调用对应 Handler。

## 6. 未决风险

- `version` 列通过新 migration 添加，既有环境需执行 migration 后方可上线本功能（`pnpm db:seed`/migrate 属运维任务）；
- 本地组合根测试不能替代部署后 Cognito、RDS 事务隔离和 Provisioning 调度延迟的观测验证；
- 审批失败的 FAILURE 审计不含 before/after 明细（DOM-03 既定语义：失败不伪造状态），排障依赖结构化日志（observability 接入后完善）。
