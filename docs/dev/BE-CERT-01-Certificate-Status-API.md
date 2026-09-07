# BE-CERT-01 Certificate Status API

实现：[certificate-status.ts](../../apps/cloud-api/src/device/certificate-status.ts)；契约：[device-certificate-api.json](../../contracts/rest/device-certificate-api.json)；测试：[certificate-status.test.ts](../../apps/cloud-api/test/certificate-status.test.ts)（PGlite 真实 PostgreSQL + 全部 migration）、[device-certificate-api.test.ts](../../contracts/rest/device-certificate-api.test.ts)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CERT-01（P1 / 设备接口），依赖 AUTH-03、DB-02（均已交付） |
| 端点 | `GET /api/v1/device/certificate/status`（Device mTLS，AUTH-03 白名单认证） |
| 响应 | `certificateId`、`status`（ACTIVE/EXPIRING/EXPIRED/REVOKED）、`expiryDate`（UTC YYYY-MM-DD）、`daysRemaining`（UTC 整日差） |
| 功能边界 | 不自动轮换、不发送到期告警（BE-CERT-02 / 告警任务边界） |

## 2. 设计要点

- **身份限定**：证书由 AUTH-03 按指纹白名单认证，查询以 `auth.certificateId` 为唯一键；可选 `query.deviceId` 提供时由 AUTH-03 强制与证书绑定设备一致（跨设备 → 403）；设备 Retired → 403（AUTH-03 既有语义）；
- **状态推导**（`deriveCertificateStatus` 纯函数，优先级从高到低）：REVOKED（storedStatus 或 revokedAt 置位）→ EXPIRED（到达 notAfter 或 storedStatus=EXPIRED）→ EXPIRING（daysRemaining ≤ 阈值，默认 30 天、部署注入）→ ACTIVE；
- **不外泄密钥材料**：只读 id/status/revokedAt/notAfter 列，certificatePem 不读取，私钥从不落库；响应 Schema `additionalProperties: false` 锁定字段集；
- EXPIRED/REVOKED 证书在 AUTH-03 认证层即 401（设备无法以失效证书调用），四态契约面向完整性与未来管理端复用。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 状态边界日 | 剩 45 天 ACTIVE；阈值当天（30 天）EXPIRING；阈值 +1 天 ACTIVE；不足一天 EXPIRING 且 daysRemaining=0；到达 notAfter EXPIRED；REVOKED 双路径（storedStatus/revokedAt） | ✅ |
| 自定义阈值 | expiringSoonDays=7 时剩 10 天 ACTIVE；=10 时 EXPIRING | ✅ |
| 跨设备查询拒绝 | query.deviceId 与 mTLS 身份不一致 → 403 FORBIDDEN；一致放行 200 | ✅ |
| 响应不包含 PEM/私钥 | 响应序列化扫描无 BEGIN CERTIFICATE/privateKey/certificatePem | ✅ |
| 未认证 | 缺证书/未登记证书/过期证书 → 401 UNAUTHENTICATED | ✅ |

复验命令：`pnpm vitest run apps/cloud-api/test/certificate-status.test.ts apps/cloud-api/test/openapi-response.test.ts`；全仓严格 Gate：`pnpm verify`。成功响应由通用 OpenAPI response validator 直接校验完整顶层 body，不再以手工字段比对代替 Schema 验收。

## 4. 对接说明

- **运行时接线**：Device API Gateway 已独占真实 `DeviceApiFn` asset；生产入口把 `$context.identity.clientCert` 规范化为 `identity` 后调用 `createCertificateStatusHandler({ client, expiringSoonDays?, now? })`，不要求 Cognito/Bearer JWT；
- **BE-CERT-02**（轮换）：EXPIRING 阈值与轮换触发窗口建议同源配置；本接口不触发任何轮换动作。

## 5. 未决风险

- EXPIRING 阈值（默认 30 天）为部署配置项，未冻结为决策；如需统一产品语义应登记决策并由契约携带；
- EXPIRED/REVOKED 无法经 mTLS 到达本端点（认证层先行 401），设备证书失效后的自助诊断需依赖带外通道（管理端/运维查询）。

## 6. 验收层级

| 层级 | 当前状态 |
|---|---|
| 模块验证 | Handler、状态边界、AUTH-03 与完整 OpenAPI 响应校验通过 |
| 生产接线 | Device API 真实 Lambda entry、mTLS identity 传递与唯一生产路由已接线 |
| 本地严格验收 | `pnpm verify` 覆盖路由/OpenAPI 双向 Gate、真实 asset Gate、CDK synth |
| 目标 AWS 运行验收 | 尚未执行；发布前需验证 mTLS 自定义域、RDS 与 API Gateway 实际响应 |
