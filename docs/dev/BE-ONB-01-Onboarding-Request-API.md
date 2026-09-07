# BE-ONB-01 Onboarding Request API

实现：[apps/cloud-api/src/onboarding](../../apps/cloud-api/src/onboarding)；契约：[contracts/rest/device-onboarding-api.json](../../contracts/rest/device-onboarding-api.json)；测试：[onboarding-request.test.ts](../../apps/cloud-api/test/onboarding-request.test.ts)（PGlite 真实 PostgreSQL + 全部 migration）、[onboarding-contract-parity.test.ts](../../apps/cloud-api/test/onboarding-contract-parity.test.ts)、[device-onboarding-api.test.ts](../../contracts/rest/device-onboarding-api.test.ts)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ONB-01（P1 / 设备接口），依赖 AUTH-02、DB-02、CT-05（均已交付） |
| 端点 | `POST /api/v1/device/onboarding/request` |
| 认证 | AUTH-02 Onboarding Token（Bearer，一次一机、与库存序列号绑定），非 mTLS（设备尚无证书） |
| 数据模型 | DB-01 `onboarding_requests`（`token_id` 唯一 + 部分唯一索引：同序列号仅一条 PENDING） |
| 错误码 | CT-05 稳定错误码目录（contracts/rest/error-codes.json） |
| 功能边界 | 不审批（BE-ONB-02）、不签发证书（BE-ONB-03）、无任何 AWS 资源副作用（纯数据库读写 + PostgreSQL 共享限频） |

## 2. 模块组成

| 模块 | 内容 |
|---|---|
| `errors.ts` | `OnboardingApiError`：VALIDATION_FAILED(400)/NOT_FOUND(404)/DEVICE_STATE_NOT_ALLOWED(409)/INTERNAL_ERROR(500)，与 CT-05 目录一致（parity 测试强制） |
| `dto.ts` | 请求体严格按 OpenAPI 五字段校验并拒绝未知字段：serialNumber（格式 `^[A-Za-z0-9-]{1,64}$`）、model/hardwareVersion/manufacturer（非空长度上限）、manufactureDate（YYYY-MM-DD、合法日历日、不晚于当前 UTC 日期） |
| `repository.ts` | `findPendingOnboardingRequest`（幂等重放判定点）、`createOnboardingRequest`（唯一冲突 P2002 原样上抛）、`isUniqueViolation`；只读/只增，无更新删除路径 |
| `service.ts` | 校验链：字段 → 凭证绑定断言（防御纵深）→ 幂等重放 → 库存授权（序列号存在）→ 设备状态（仅 PendingOnboarding）→ 创建；并发 P2002 回读胜出记录幂等返回 |
| `handler.ts` | 框架无关 Handler：限频（缺省 30 次/60s 按 Token 指纹）→ `withOnboardingAuth` → Service；201 新建 / 200 重放；错误映射不泄露堆栈/SQL/AWS 细节 |

配套变更：`@fdp/cloud-api` 新增 `@fdp/auth` 依赖与 PGlite 测试依赖；`contracts/rest/` 新增端点 OpenAPI（相对引用 openapi-base.json 组件）与其契约测试。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 正向返回 requestId/PENDING | 201 新建 / 200 幂等重放，响应顶层严格为 `{requestId,status}`，并由实际 Handler 响应通过 OpenAPI Schema 校验 | ✅ |
| 负向-字段非法 | 缺字段/空值/日期格式错误/非法日历日（2026-02-30）/未来日期/畸形序列号 → 400 VALIDATION_FAILED | ✅ |
| 负向-序列号不存在 | 库存无此序列号 → 404 NOT_FOUND | ✅ |
| 负向-已 Onboarded | 设备 lifecycleStatus=Onboarded → 409 DEVICE_STATE_NOT_ALLOWED | ✅ |
| 负向-未认证 | 缺 Token/伪造 Token/跨序列号 → 401 UNAUTHENTICATED | ✅ |
| 重复请求幂等 | 二次提交 → 200 + 原 requestId；不覆盖原申请内容；全库仅一条记录 | ✅ |
| 并发重复提交 | 5 并发 → 全部同一 requestId、仅一条记录；P2002 冲突回读路径由 stub 确定性复现 | ✅ |
| 稳定错误码 | 实现错误码/HTTP 状态与 error-codes.json 目录逐项一致；DTO 字段与 OpenAPI 请求体一致 | ✅ |
| 无 AWS 资源副作用 | onboarding 模块源码扫描无 `@fdp/aws-clients`/`@aws-sdk` 引用；测试无网络/AWS 调用 | ✅ |

## 4. 交付状态（2026-09-07）

| 维度 | 状态 | 说明 |
|---|---|---|
| 模块验证 | PASS | Handler/Service/Repository、严格 DTO、幂等与负向测试均通过；200/201 实际响应由 OpenAPI Schema 校验 |
| 生产接线 | PASS（代码/IaC） | 独立 Device Onboarding Lambda 与 API Gateway 两条设备路由已接线；共享 PostgreSQL 限频已启用 |
| 严格验收 | PASS（本地） | 2026-09-07 `pnpm verify` 退出 0：实现 986/986、契约 285/285、脚本 80/80；历史快照：2026-08-27 曾记录模块 14/14、契约 133/133，仅作时点证据 |

## 5. 对接说明（下游任务）

- **BE-ONB-02**（审批）：读 `onboarding_requests` PENDING 列表；approve/reject 迁移状态并写审计（仅本任务创建，状态更新归 BE-ONB-02）；
- **BE-ONB-03**（签发）：APPROVED 后创建 Device/IoT 资源；证书包领取成功调用 `markOnboardingTokenUsed` 核销 Token（AUTH-02）；
- **运行时接线**：`device-onboarding-entry.ts` 初始化数据库与 Handler，`device-onboarding-lambda.ts` 将 API Gateway 事件规范化为 `{ headers, body, requestId }`；生产默认使用 PostgreSQL 共享限频。

## 6. 未决风险

- 本地测试与 CDK synth 不能替代部署后 API Gateway、RDS、KMS 与真实设备的联调验证；
- REJECTED 设备的重试语义由 BE-ONB-02 审批流决定：当前设备生命周期进入 Rejected 后再次提交返回 409（DEVICE_STATE_NOT_ALLOWED），如需"拒绝后可重新申请"需决策登记变更；
