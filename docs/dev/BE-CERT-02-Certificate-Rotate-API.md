# BE-CERT-02 Certificate Rotate API

实现：[certificate-rotate.ts](../../apps/cloud-api/src/device/certificate-rotate.ts)（Service）、[rotate-handler.ts](../../apps/cloud-api/src/device/rotate-handler.ts)（API）、[rotation-confirmation.ts](../../apps/ingestion-worker/src/rotation-confirmation.ts)（首 Heartbeat 确认）；契约：[device-certificate-api.json](../../contracts/rest/device-certificate-api.json)；测试：[certificate-rotate.test.ts](../../apps/cloud-api/test/certificate-rotate.test.ts)、[rotation-confirmation.test.ts](../../apps/ingestion-worker/test/rotation-confirmation.test.ts)（PGlite 真实 PostgreSQL + 全部 migration + mock IoT）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CERT-02（P1 / 设备接口），依赖 BE-CERT-01、SEC-01、AUTH-04、DEC-003（均已交付；DEC-003 已冻结为 1.0.0） |
| 端点 | `POST /api/v1/device/certificate/rotate`（Device mTLS，AUTH-03） |
| 响应 | 顶层 `certificateId`、`certificatePem`、`privateKey`（仅本响应一次）、`effectiveDate`/`expiryDate`（UTC `YYYY-MM-DD`） |
| 双证书窗口 | 新证书 ACTIVE + `rotatedFromId`=旧证书；旧证保持 ACTIVE 可用直至新证书首个合法 Heartbeat 确认 |
| 功能边界 | 不实现定时到期扫描和人工证书运维 |

## 2. 轮换与确认流程

**Rotate**（cloud-api）：AUTH-03 认证（旧证 ACTIVE 且属于设备，撤销/过期 → 401）→ 请求体只允许 `currentCertificateId`（额外字段 → 400）→ 当前证书必须等于身份证书（错误/跨设备 → 403）→ AWS 发证 + AUTH-04 单设备 Policy（幂等）+ attach → 新证书 ACTIVE（rotatedFromId 记录窗口）+ CERT_ROTATION_START 审计 → SEC-01 信封加密封包 → 返回明文包。状态机区分：从未封包失败可本地撤销后重签；已预留但提交不确定时撤销 IoT 新证并销毁包后有界重签；响应已成功提交但尚未 Heartbeat 时稳定返回 409，绝不撤销已交付新证或无限重签。

**Confirm**（ingestion-worker 生产消费入口）：心跳证书为轮换新证书（ACTIVE + rotatedFromId 非空）且旧证仍 ACTIVE → 事务内条件更新旧证 REVOKED（并发仅一个生效）+ SEC-01 销毁新证书包 + CERT_ROTATION_CONFIRM 审计；确认后/非轮换证书的心跳由预检静默幂等。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 旧证书错误/撤销/跨设备均拒绝 | 缺字段 400；与身份不符（含他设备证书）403；撤销 401 | ✅ |
| 重试不产生无限证书 | 成功提交后重复请求稳定 409，AWS 发证调用恒为 1，新证保持 ACTIVE，轮换子记录唯一 | ✅ |
| 部分失败可重试 | attach 失败 → 500 且无孤儿业务记录；重试成功（有界替换） | ✅ |
| 切换前旧证可用 | 轮换后旧证书 AUTH-03 认证仍通过（双证书窗口） | ✅ |
| 确认后旧证禁用 | 首 Heartbeat 确认 → 旧证 REVOKED + revokedAt，旧证认证 401 | ✅ |
| 敏感包销毁证明 | 确认后新证书 packageCiphertext 为 null + CERT_PACKAGE_DESTROY 审计 | ✅ |
| 幂等 | 并发确认恰一个生效；重复确认/非轮换 Heartbeat 无副作用 | ✅ |
| 私钥安全 | 私钥不落库、不进审计（序列化扫描） | ✅ |

复验命令：`pnpm vitest run apps/cloud-api/test/certificate-rotate.test.ts apps/cloud-api/test/device-lambda-composition.test.ts apps/ingestion-worker/test/rotation-confirmation.test.ts`；全仓严格 Gate：`pnpm verify`。

## 4. 对接说明

- **Heartbeat 接线**：ingestion worker 认证后并列调用 BE-ONB-04 与 BE-CERT-02 两个确认扩展点；
- **BE-CERT-01**：设备可通过 status 接口观察新证书状态（新证 ACTIVE 后查询即生效）；
- **运行时**：Device API 真实 Lambda entry 已注入 IoT Port、KMS/数据库及 DEC-003 冻结包策略；响应完成 JSON 序列化后才执行交付确认。

## 5. 未决风险

- 成功响应已提交但设备随后丢失明文包时，DEC-003 失败关闭为 409，需走带外运维重签；该取舍已随 DEC-003@1.0.0 冻结；
- AWS 发证成功但 DB 落库失败产生 AWS 侧孤儿证书（与 BE-ONB-03 同一风险，运维对账清理）；
- 目标 AWS 账号中的 IoT 发证、KMS 一次性包和首个 Heartbeat 切换仍须部署后演练。

## 6. 验收层级

| 层级 | 当前状态 |
|---|---|
| 模块验证 | 交付三态、额外字段、重复 Rotate、私钥不落库和 Heartbeat 并发确认通过 |
| 生产接线 | Device API、IoT/KMS Port、提交回调及 ingestion Heartbeat 确认均有真实入口 |
| 本地严格验收 | 完整 OpenAPI body、生产路由和真实 Lambda asset Gate 均纳入 `pnpm verify` |
| 目标 AWS 运行验收 | 尚未执行；发布前补 IoT/KMS/mTLS/Heartbeat 全链演练与清理回执 |
