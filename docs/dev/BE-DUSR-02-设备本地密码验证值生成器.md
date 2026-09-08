# BE-DUSR-02 设备本地密码验证值生成器

实现：[apps/cloud-api/src/admin/device-user/verifier.ts](../../apps/cloud-api/src/admin/device-user/verifier.ts)；验收测试：[device-user-verifier.test.ts](../../apps/cloud-api/test/device-user-verifier.test.ts)。

> 证据治理：当前本地全仓证据命令为 `pnpm verify`；精确快照与整改闭环见 [全面复盘检查报告](../audit/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md)。目标 AWS 验收必须按 [证据采集说明](../audit/evidence/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md) 生成与待发布提交绑定的回执，并通过 `pnpm check:aws-admin-business-evidence`；缺失回执不得以本地测试替代。

## 1. 范围与前置状态

| 项 | 说明 |
|---|---|
| 任务 | BE-DUSR-02（P1 / 后端安全），依赖 BE-DUSR-01（已交付）、DEC-004@1.0.0（已冻结）、SEC-01 |
| 关键前置 | 协议参数已冻结为 Argon2id v=19、m=32768 KiB、t=3、p=1、salt=16 字节、hash=32 字节；生产实现严格校验并输出标准 PHC |
| 交付物映射 | 生成/验证 → `hashDeviceUserPassword` / `verifyDeviceUserPassword`；持久化与 Sync 线协议 → 单一 `passwordHash` PHC 字符串；固定向量进入自动化测试 |
| 功能边界 | 不实现设备端登录；明文密码仅存在于生成管线内存中 |

## 2. 关键设计

**固定参数生产实现**：使用 `argon2` 的 Argon2id 实现，显式传入 version=19、memoryCost=32768、timeCost=3、parallelism=1、hashLength=32 和 16 字节随机 salt。生成后再次解析 PHC 并校验参数，任何漂移均 fail-closed。

**生成管线**：明文密码校验（非空、≤1024 字节）→ CSPRNG 生成每用户独立 16 字节 salt → Argon2id 派生 32 字节 hash → 标准 PHC 编码 → 参数和长度复核。返回值只有 PHC，不含明文密码或拆分组件。

**脱敏管线**（接口日志和审计必须脱敏）：首要防线是 DTO 不含材料（BE-DUSR-01 已保证查询 API 永不返回 verifier\*、拒收明文密码字段）；本模块提供最后防线 `redactVerifierSecrets`（文本中出现的 hash/salt/明文密码替换为 `[REDACTED]`，≥8 字符才参与比对，去重 + 长串优先）与 `assertNoVerifierLeak`（泄漏即 fail-fast）。

**下发通道**：仅 Unified Device Sync 的 Device Users 域；线路字段为 `passwordHash`，不再下发 `version/kdf/salt/hash` 或嵌套 `verifier`。

## 3. 验收基准与证据（vitest）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 不同 salt 结果不同 | 同密码两次生成的 PHC 不同，且均可成功复验 | ✅ |
| 固定测试向量可被设备方复验 | 固定 password/salt 得到冻结 PHC，并以独立 verify 路径复验 | ✅ |
| 任何 API 查询都不能返回原密码 | 管理 DTO、审计和 Sync 均不含明文密码；管理查询不返回 PHC | ✅ |
| 不得使用 Cognito/云端密码 Hash | 管线输入为明文密码 + 每用户独立 salt，输出与云端材料无关（策略 cloudHashReuse=false 锁定，由 contracts 侧测试强制） | ✅ |
| 日志/审计脱敏 | redact 替换 hash/salt/密码且保留非敏感内容；assertNoVerifierLeak 泄漏 fail-fast；短值不参与比对防误伤 | ✅ |
| 参数与输入 fail-closed | 非法 PHC、错误密码、空密码、超长密码和非法 salt 均被拒绝 | ✅ |

## 4. 未决风险

- 最低配置目标设备约 250～500 ms 的性能指标仍需由真实设备侧提供验收收据；服务端测试只证明格式和参数一致性。
- 历史 verifier 拆分列仍在数据库中兼容存量数据；删除前需先确认生产数据迁移和回滚窗口。
