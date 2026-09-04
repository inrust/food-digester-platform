# BE-DUSR-02 设备本地密码验证值生成器

实现：[apps/cloud-api/src/admin/device-user/verifier.ts](../apps/cloud-api/src/admin/device-user/verifier.ts)；验收测试：[device-user-verifier.test.ts](../apps/cloud-api/test/device-user-verifier.test.ts)（10 项，纯函数管线）。

## 1. 范围与前置状态

| 项 | 说明 |
|---|---|
| 任务 | BE-DUSR-02（P1 / 后端安全），依赖 BE-DUSR-01（已交付）、DEC-004@1.0.0（已冻结）、SEC-01 |
| 关键前置 | 协议参数已冻结为 Argon2id v=19、m=32768 KiB、t=3、p=1、salt=16 字节、hash=32 字节；当前代码仍只有 adapter 接口和脱敏管线，生产 Argon2id adapter、PHC 编码及固定测试向量待实现 |
| 交付物映射 | KDF adapter → `VerifierKdfAdapter` 接口；内部 DTO → `GeneratedVerifierMaterial` 四组件；线协议 → `passwordHash` PHC 字符串；生产 Argon2id adapter 与固定测试向量待补齐 |
| 功能边界 | 不实现设备端登录；明文密码仅存在于生成管线内存中 |

## 2. 关键设计

**注入式策略门面（fail-closed 透传）**：`VerifierPolicyQuery` 镜像 `contracts/security/device-user-verifier-policy.ts` 的冻结参数查询签名。组合根必须经该模块接线（cloud-api 不经 tsc 构建引用 contracts 源码包；DEC-004 约束消费方只能经 policy 模块查询，禁止直接读 JSON 或复制暂定值）。provisional 期间策略查询抛错，生成器不捕获、不兜底——任何生成调用失败关闭；冻结后仅替换注入的 adapter 与策略查询，管线与 DTO 不变。

**生成管线**（`generateVerifierMaterial`）：明文密码校验（非空、≤1024）→ 策略参数读取 → adapter.kdfId 与策略 material.kdf 一致性校验（防接线错配，错配 → CONFLICT）→ CSPRNG 独立 salt（每用户随机，长度=策略 saltBytes）→ adapter 派生（输出长度=策略 hashBytes，不符 → CONFLICT）→ base64 四字段 DTO（`version` 取自 adapter.materialVersion，支持算法迁移）。返回值不含明文密码。

**脱敏管线**（接口日志和审计必须脱敏）：首要防线是 DTO 不含材料（BE-DUSR-01 已保证查询 API 永不返回 verifier\*、拒收明文密码字段）；本模块提供最后防线 `redactVerifierSecrets`（文本中出现的 hash/salt/明文密码替换为 `[REDACTED]`，≥8 字符才参与比对，去重 + 长串优先）与 `assertNoVerifierLeak`（泄漏即 fail-fast）。

**下发通道**：仅 Unified Device Sync 的 Device Users 域；内部四组件必须在线路边界编码为 `passwordHash` PHC 字符串，不能继续把 `version/kdf/salt/hash` 作为四个线协议字段下发。

## 3. 验收基准与证据（vitest，10 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 不同 salt 结果不同 | 同密码两次生成：CSPRNG 独立 salt → salt/hash 均不同 | ✅ |
| 固定测试向量可被设备方复验 | **冻结后补齐**；本次以模拟冻结 adapter（sha256 测试实现）验证管线语义：注入固定 salt 源 → 输出确定，且设备方独立重算得到相同 hash | ✅（管线语义） |
| 任何 API 查询都不能返回原密码 | DTO 不含明文密码（序列化断言）；BE-DUSR-01 已有覆盖：查询 API 永不返回 verifier\*、拒收明文密码字段、审计脱敏 | ✅ |
| 不得使用 Cognito/云端密码 Hash | 管线输入为明文密码 + 每用户独立 salt，输出与云端材料无关（策略 cloudHashReuse=false 锁定，由 contracts 侧测试强制） | ✅ |
| 日志/审计脱敏 | redact 替换 hash/salt/密码且保留非敏感内容；assertNoVerifierLeak 泄漏 fail-fast；短值不参与比对防误伤 | ✅ |
| 冻结前 fail-closed | provisional 策略 → 生成抛 PolicyParameterPendingError（透传不兜底）；kdfId 错配/空密码/salt 长度漂移 → CONFLICT/VALIDATION_FAILED | ✅ |

## 4. 未决风险

- **固定测试向量和生产 adapter 缺失**：需按 DEC-004@1.0.0 实现 Argon2id/PHC，并提供设备端可独立复验的固定向量；
- 组合根接线待落地：Lambda 入口需把 `VerifierPolicyQuery` 绑定到 contracts policy 模块查询函数（当前仅测试以模拟策略验证两种状态）；
- 生成器未被任何 API 调用：BE-DUSR-01 仍只接受预计算验证材料；冻结后如需"云端代生成"写路径（管理员设密码时云端派生），需新任务定义其授权与审计语义（明文密码过 API 的传输保护）。
