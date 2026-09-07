# BE-ONB-04 首个 Heartbeat 完成 Onboarding

实现：[apps/ingestion-worker/src/onboarding-completion.ts](../../apps/ingestion-worker/src/onboarding-completion.ts)；测试：[onboarding-completion.test.ts](../../apps/ingestion-worker/test/onboarding-completion.test.ts)（PGlite 真实 PostgreSQL + 全部 migration + SEC-01 真实信封加解密）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ONB-04（P1 / 后端领域集成），依赖 BE-ONB-03、BE-IOT-04；当前 Heartbeat 生产调用链和 deadline 调度均已接线 |
| 触发点 | BE-IOT-04 在消息认证（AUTH-03 提取 deviceId + 证书指纹）与 latest state 更新后调用 `completeOnboardingOnFirstHeartbeat` |
| 生命周期 | DOM-01：OnboardingApproved → Onboarded（SYSTEM actor，前置 certificateInstalled + firstHeartbeatReceived） |
| 证书包 | DEC-003 销毁触发点 NEW_CERTIFICATE_FIRST_HEARTBEAT：SEC-01 `destroyPackage`（幂等，本任务扩展支持事务客户端） |
| 超时 | DEC-017@1.0.0：证书包存储后 24 小时硬截止，TIMED_OUT 内部状态、REJECTED 外部映射、撤证销包、新 Token 重新申请 |
| 功能边界 | 不自动分配 Customer/Site，不自动发 License |

## 2. 处理链（单事务原子执行）

1. 预检幂等：设备已 Onboarded → 直接返回 transitioned=false（不产生审计噪音）；
2. 事务内：设备存在性与状态校验（仅 OnboardingApproved 可迁移，其余 → DEVICE_STATE_NOT_ALLOWED）；
3. 证书匹配：`device_certificates` 按 fingerprint + deviceId 对应且未 REVOKED/EXPIRED，不匹配 → FORBIDDEN；
4. DOM-01 `transitionLifecycle` 产出状态历史与审计描述；
5. 条件更新 `(id, lifecycleStatus='OnboardingApproved')` 保证并发首个 Heartbeat 仅一个生效（败方转幂等重放）；
6. 同事务：状态历史落库、证书 PENDING_CLAIM → ACTIVE、证书包销毁（幂等）、`device_latest_state` 落上线基点（connectivity=ONLINE + lastHeartbeatAt）；
7. DOM-03 `audited()`：成功 SUCCESS / 失败 FAILURE 审计（不伪造成功）。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 首个合法 Heartbeat 迁移一次 | 迁移 + 历史 1 条 + 证书 ACTIVE + 上线时间 + SUCCESS 审计全链断言 | ✅ |
| 敏感包销毁测试证明 | 迁移前密文存在（前置断言），迁移后 packageCiphertext/packageKmsKeyId 为 null + CERT_PACKAGE_DESTROY 审计 | ✅ |
| 其他证书不迁移 | 指纹不匹配 → FORBIDDEN，设备状态不变，记 FAILURE 审计 | ✅ |
| 非法状态不迁移 | PendingOnboarding / Active → DEVICE_STATE_NOT_ALLOWED，无状态历史 | ✅ |
| 重复 Heartbeat 幂等 | 二次调用 transitioned=false，历史/审计计数不变；并发双 Heartbeat 恰一个生效 | ✅ |
| 已领取（无密文）场景 | 迁移照常成功，销毁幂等 false，证书置 ACTIVE | ✅ |
| 截止边界与幂等 | 截止前不处理；精确边界只迁移一次；重复评估无重复历史/审计 | ✅ |
| 超时处置 | 申请 TIMED_OUT、设备 PendingOnboarding、证书 REVOKED、密文销毁、迟到 Heartbeat 拒绝 | ✅ |
| 云端撤证恢复 | 首次失败保留 revocationCompletedAt=null，下一轮只重试撤证 | ✅ |

## 4. 交付状态（2026-09-07）

| 维度 | 状态 | 说明 |
|---|---|---|
| 模块验证 | PASS | 首个 Heartbeat、截止边界、迟到拒绝、并发幂等、撤证失败恢复均有 PGlite 测试 |
| 生产接线 | PASS（代码/IaC） | 真实 Ingestion Lambda 调用 dispatcher/Heartbeat Handler；独立 deadline Lambda 由 EventBridge 分钟调度 |
| 严格验收 | PASS（本地） | 2026-09-07 `pnpm verify` 退出 0：实现 986/986、契约 285/285、脚本 80/80；历史快照：2026-09-04 曾记录 DEC-017 聚焦 128/128、实现 683/683、契约 250/250、脚本 53/53，仅作时点证据 |

## 5. 对接说明（下游任务）

- **BE-IOT-04**（Heartbeat Handler）：在 AUTH-03 认证与 latest state 覆盖更新后调用本扩展点，传入 `{ deviceId, certificateFingerprint, occurredAt }`；本 Handler 的 FORBIDDEN（证书不匹配）应升级为安全事件（ingestion_receipts SECURITY_VIOLATION 由 BE-IOT-03 幂等层记录）；
- **BE-CERT-02**（轮换）：轮换新证书的首个 Heartbeat 复用同一扩展点（设备已 Onboarded 时本 Handler 幂等短路；轮换场景的包销毁触发点由 BE-CERT-02 自行调用 destroyPackage）。

## 6. 未决风险

- 上线基点与全量 latest state 由已接线的 BE-IOT-04 消费链共同维护；目标环境仍需用真实 SQS/IoT 事件执行部署后验收；
- 重复 Heartbeat 的预检在事务外（根客户端），极端并发下两个请求都进入事务：由条件更新兜底，败方记一条 transitioned=false 的 SUCCESS 审计（罕见且语义正确）；
