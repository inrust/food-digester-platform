# SEC-01 敏感材料保护组件

实现：`@fdp/auth` [secure-package](../../packages/auth/src/secure-package)、`@fdp/aws-clients` [kms-data-key-provider](../../packages/aws-clients/src/kms-data-key-provider.ts)、`@fdp/observability` [redaction](../../packages/observability/src/redaction.ts)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | SEC-01（P0 / 后端安全），依赖 IAC-01、DOM-03、DEC-003（均已就绪） |
| 策略 | DEC-003@1.0.0（frozen）：KMS 信封加密保存 86400 秒、一次成功领取、成功响应提交后销毁；响应不确定、丢失或过期时吊销未确认新证书并重签 |
| KMS | IAC-01 已创建 `fdp-{env}-cert-package` 专用 Key，加解密权限仅授予 API Lambda 角色 |
| 审计 | DOM-03 `recordAudit`（同事务 SUCCESS / 独立 FAILURE） |

## 2. 模块组成

| 模块 | 内容 |
|---|---|
| `aws-clients/kms-data-key-provider.ts` | `DataKeyProvider` 抽象 + KMS 实现（`GenerateDataKey` AES_256 / `Decrypt`）；客户端可注入（测试 mock，无网络） |
| `auth/secure-package/envelope.ts` | 信封格式 `[u16 密文密钥长度][密文数据密钥][12B IV][16B GCM Tag][密文]`（AES-256-GCM），整体存 `package_ciphertext` |
| `auth/secure-package/service.ts` | `SecurePackageService`：`storePackage`（发证后立即加密）、两阶段单次交付、事务确认、过期恢复扫描与幂等销毁 |
| `auth/secure-package/local-test-key-provider.ts` | 测试专用密钥适配器（本地派生主密钥，明确禁止生产） |
| `observability/redaction.ts` | 字段名 + 值形态双层脱敏（PEM 私钥块、Bearer 凭证（含历史 Token 模式））、`createRedactingLogger` |

## 3. 领取规则（DEC-003 落地）

- **资格**：仅对应申请 CSR 私钥签名验证（requestId 与序列号绑定）或设备证书（deviceId 绑定，AUTH-03 ctx）；不符 → 403 且密文保留；
- **一次性**：`claimedAt` 条件更新单次锁；重复/并发领取 → 409 失败关闭；
- **销毁**：响应提交后将密文清理与交付确认置于同一事务；过期包先进入持久化恢复状态机，AWS 撤证成功后才清密文并重签；新证书 Heartbeat 后由 BE-ONB-04 调 `destroyPackage`；
- **审计**：store/prepare/confirm/recovery/destroy 全部落 `audit_logs`，负载只含 ID/指纹/Key 标识。

## 4. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 数据库无明文私钥 | store 后行密文 hex 断言不含明文负载；审计序列化不含私钥材料 | ✅ |
| 重复领取遵循 DEC-003 | 领取后密文销毁 → 404；单次锁并发场景 → 409；`maxClaims≠1` 构造拒绝 | ✅ |
| 错误日志/Trace/审计扫描无敏感内容 | 双层脱敏测试（字段名/PEM 块/Token/Bearer/Error message/嵌套）+ redactingLogger 全级别断言 | ✅ |
| 解密权限仅限指定 Lambda role | IAC-01：`certPackageKey.grantEncryptDecrypt` 仅授予 API Lambda 角色（模板断言已覆盖） | ✅ |
| 仅对应 CSR 私钥/设备证书可领取 | 跨序列号/跨 deviceId → 403；绑定匹配 → 通过 | ✅ |
| 首次接入项目 CA 对 CSR 公钥签证后立即加密 | storePackage 接口契约：明文入参仅经内存，落库为信封密文（测试断言） | ✅ |

当前证据命令：`pnpm vitest run packages/auth/test packages/aws-clients/test packages/observability/test`、`pnpm verify`。精确测试快照记录在 `docs/audit`，任务文档不固化易漂移计数。

## 5. 对接说明

- **BE-ONB-03**：项目 CA 内存签发并完成 `RegisterCertificateWithoutCA` 后立即 `storePackage`；响应组装用 `preparePackageDelivery`，提交确认用 `confirmPackageDelivery`（proof = onboardingCsr ctx）；
- **BE-ONB-04 / BE-CERT-02**：轮换重领用 `deviceCertificate` proof；新证书首个合法 Heartbeat 后 `destroyPackage(旧证书)`；
- **DEC-003 接线**：`retentionSeconds=86400`、`maxClaims=1` 必须从冻结策略文件读取，不得继续由部署环境指定其他值。

## 6. 未决风险

- KMS 真实往返未在本地测试覆盖（mock 验证命令接线）；dev 环境首次部署需联调 GenerateDataKey/Decrypt 权限；
- 定时 sweeper 与恢复状态机已落地；实际 AWS 撤证、KMS 往返和重签链仍需在部署环境复验；
- `local-test-key-provider` 存在于发布产物中，依赖代码评审与命名警示防误用；后续可考虑拆分到 test-only 包。
