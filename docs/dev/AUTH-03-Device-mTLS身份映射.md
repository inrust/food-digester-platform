# AUTH-03 Device mTLS 身份映射

实现：[packages/auth/src/device](../../packages/auth/src/device)；测试：[device-mtls.test.ts](../../packages/auth/test/device-mtls.test.ts)（PGlite 真实 PostgreSQL + 实际 migration.sql）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | AUTH-03（P0 / 设备接口），依赖 DB-01、IAC-01（均已交付） |
| 落点 | `@fdp/auth` 包 `device/` 子模块（第三种认证机制，与 Cognito/Onboarding Token 并列） |
| 白名单 | DB-01 `device_certificates`（`fingerprint` 唯一索引、`status`、`notBefore/notAfter`、`deviceId` 绑定） |
| 生命周期 | DOM-01：Retired 永久退役拒绝一切接入；Suspended 允许心跳/遥测（业务级限制归 BE 任务） |
| 功能边界 | 不负责 TLS 握手（API Gateway mTLS 域名，IAC-01）与证书签发（BE-ONB-03） |

## 2. 模块组成

| 模块 | 内容 |
|---|---|
| `mtls-context.ts` | `ClientCertIdentity`（API Gateway `$context.identity.clientCert` 子集）；`certificateFingerprintFromPem`（PEM→DER→SHA-256） |
| `verifier.ts` | `verifyDeviceCertificate` 校验链 + `DeviceAuthContext`（deviceId/certificateId/指纹/customerId/siteId/lifecycleStatus） |
| `guard.ts` | `withDeviceAuth` 中间件：提取证书上下文与路径 deviceId，校验后注入上下文 |

校验链（顺序即防线）：

1. 证书上下文缺失/PEM 畸形 → 401；
2. 指纹查 `device_certificates`，**同 CA 未登记证书 → 401**（CA 链验证不替代应用白名单）；
3. 状态必须 `ACTIVE`（`PENDING_CLAIM`/`REVOKED`/`EXPIRED` → 401）；`revokedAt` 置位冗余防线 → 401；
4. 有效期 `notBefore ≤ now < notAfter`（DB 记录为准）→ 否则 401；
5. 请求 `deviceId` 与证书绑定设备不一致 → 403；
6. 设备 `Retired` → 403；`Suspended` 放行（行为矩阵：心跳/遥测/OTA 仍允许）；
7. 注入 device/customer context。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 有效证书通过 |  ACTIVE + 有效期内 → 注入完整上下文（含 customerId） | ✅ |
| 同 CA 未登记证书拒绝 | 指纹不在白名单 → 401 | ✅ |
| 已撤销/过期证书拒绝 | REVOKED/EXPIRED/PENDING_CLAIM、revokedAt 置位、有效期外 → 401 | ✅ |
| 请求其他 deviceId 拒绝 | 绑定 A 设备的证书请求 B → 403，不进入 Handler | ✅ |
| Retired 拒绝 / Suspended 放行 | 403 / 通过且上下文携带生命周期 | ✅ |
| 中间件缺失证书 → 401 | `withDeviceAuth` 无 clientCert → 401 | ✅ |

当前证据命令：`pnpm vitest run packages/auth/test`、`pnpm verify`。精确测试快照记录在 `docs/audit`，任务文档不固化易漂移计数。

## 4. 对接说明（下游任务）

- **Device API 路由**（BE-CMD/BE-OTA/BE-MED 等）：`withDeviceAuth({ client, identityOf, deviceIdOf }, handler)` 接线；`identityOf` 从 API Gateway 代理事件 `requestContext.identity.clientCert` 提取；
- **错误映射**：`AuthError`（401/403）由 API 适配层按 CT-05 错误响应包装；
- **SEC/审计**：日志与审计只允许记录 `certificateFingerprint`，不记录证书 PEM 全文。

## 5. 未决风险

- API Gateway mTLS 信任链配置（truststore 上传、域名证书）属部署演练项（IAC-01 文档已列），首连演练归 QA-03；
- 证书轮换（BE-CERT-02）上线后，新旧证书短暂并存期间两条记录均为 ACTIVE，白名单天然支持；
- 设备 `Suspended` 状态在认证层放行是行为矩阵的明确决策，命令级权限检查由 BE-CMD-02 执行。
