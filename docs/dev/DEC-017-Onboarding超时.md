# DEC-017 Onboarding 超时

## 冻结结论

DEC-017@1.0.0 选择方案 A：证书包成功存储时开始 24 小时首个合法 Heartbeat 硬截止，精确截止边界计入超时。

超时处置如下：

- Onboarding 申请内部置为 `TIMED_OUT`，外部保持源协议三态并映射为 `REJECTED`，稳定原因为 `ONBOARDING_TIMEOUT`；
- 未确认新证书置为 `REVOKED`，密文包立即销毁并调用云端撤证；云端失败由下一轮评估器只重试撤证；
- 设备从 `OnboardingApproved` 回到既有 `PendingOnboarding`，不新增生命周期状态；
- 截止前证书包过期仍按 DEC-003 撤证重签；超时证书的迟到 Heartbeat 失败关闭，超时后不自动重签；重新申请必须生成新 CSR 并创建新申请。

## 证据

- 冻结策略：`contracts/lifecycle/onboarding-timeout-policy.json`
- Deadline 写入：`apps/cloud-api/src/provisioning/service.ts`
- 外部状态映射：`apps/cloud-api/src/onboarding/status-handler.ts`
- 超时评估与迟到拒绝：`apps/ingestion-worker/src/onboarding-completion.ts`
- 数据迁移：`packages/database/prisma/migrations/20260904111500_dec017_onboarding_deadline/migration.sql`

## 验证结果

- DEC-017 聚焦测试：128/128 通过；
- 全仓 `pnpm verify`：实现测试 683/683、契约测试 250/250、脚本测试 53/53，类型检查 19/19、构建 13/13，迁移、Schema、模块边界与敏感信息门禁全部通过（2026-09-04）。
