# BE-ONB-03 证书签发与 Onboarding Status API

实现：[apps/cloud-api/src/provisioning](../../apps/cloud-api/src/provisioning)、[status-handler.ts](../../apps/cloud-api/src/onboarding/status-handler.ts)；契约：[contracts/rest/device-onboarding-api.json](../../contracts/rest/device-onboarding-api.json)（status 端点）；测试：[provisioning.test.ts](../../apps/cloud-api/test/provisioning.test.ts)、[onboarding-status.test.ts](../../apps/cloud-api/test/onboarding-status.test.ts)（PGlite 真实 PostgreSQL + 全部 migration + 内存 mock IoT Port）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ONB-03（P1 / 设备接口），依赖 BE-ONB-02、SEC-01、AUTH-04、DEC-003、DEC-017（均已交付） |
| 端点 | `GET /api/v1/device/onboarding/status`（Onboarding Token 认证，由 Token 绑定隐式定位申请，无 serialNumber Query） |
| 签发链 | approve（BE-ONB-02）同事务写 Provisioning Job → 定时 Worker 条件认领 → 从 Secrets Manager 读取项目 CA → 内存签发设备叶证书 → RegisterCertificateWithoutCA → 证书记录 → AUTH-04 Policy/Thing attach → SEC-01 信封加密封包 |
| 测试环境证书边界 | Onboarding 返回的同一张项目 CA 叶证书同时用于 AWS IoT MQTT 客户端认证和 Device REST mTLS；不再签发或兼容第二张 AWS IoT 原生设备证书 |
| 证书包 | DEC-003@1.0.0/SEC-01：KMS 信封加密保存 86400 秒、一次成功领取、成功响应提交后销毁；响应不确定、丢失或过期时吊销未确认新证书并重签 |
| 功能边界 | 内部 Provisioning 不暴露为外部状态（未就绪对外一律 PENDING）；不实现 CSR |

## 2. 模块组成

| 模块 | 内容 |
|---|---|
| `provisioning/iot-port.ts` | IoT 端口及 AWS SDK 适配器：Thing/Policy 幂等操作、发证、附加、撤证与资源标签 |
| `provisioning/service.ts` | 幂等签发、即时补偿撤证、持久化对账凭证、一次性封包及 Status 截止主动收敛 |
| `provisioning/worker.ts` | 持久化 Job 条件认领、租约恢复、指数退避、attempt/lastError/nextAttemptAt、失败审计与告警 Outbox |
| `onboarding/status-handler.ts` | 源协议三态顶层响应；实际 PENDING/REJECTED/APPROVED 响应均由 OpenAPI Schema 校验 |
| `onboarding/repository.ts` | 新增 `findOnboardingRequestByTokenId`（Token 一次一机精确查询） |

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 三类响应符合契约 | PENDING（无证书材料字段）/ REJECTED（含原因）/ APPROVED 全字段 + heartbeatInterval=60 | ✅ |
| 内部 Provisioning 不暴露 | APPROVED 但未注入 trigger（证书包未就绪）→ 对外 PENDING | ✅ |
| AWS 部分失败可重试且不重复创建业务 Device | attachPolicy 首次失败 → 重试成功；device 计数恒为 1；幂等重放不重复调用 AWS 发证 | ✅ |
| 孤儿证书处置 | 封包前失败的 PENDING_CLAIM 遗留记录重试时 REVOKED 并重签 | ✅ |
| 一次性安全领取 | 领取后 packageCiphertext 销毁为 null；Token 核销后再次访问 401；重复领取由 SEC-01 单次锁 409 | ✅ |
| 管理员 API/日志看不到私钥 | 审计（provisioning/store/claim）与 admin detail 序列化扫描无私钥明文；证书记录列无明文 | ✅ |
| 负向 | Token 无申请 404；伪造 Token 401；Status 不接受也不要求 serialNumber Query | ✅ |
| 持久化重试 | 并发认领最多一次、租约恢复不重复消耗 attempt、指数退避、耗尽告警与失败审计 | ✅ |
| AWS 对账补偿 | 创建后立即保存 certificateId；request/operationId 写入业务审计，并结合 CloudTrail request ID 与 certificateId 对账；任一后续失败先撤证，撤证失败保留凭证供重试。AWS IoT 普通 cert 资源不支持 TagResource。 | ✅ |

## 4. 交付状态（2026-09-07）

| 维度 | 状态 | 说明 |
|---|---|---|
| 模块验证 | PASS | 三态协议、一次性领取、补偿、Job 重试/并发/租约及超时收敛均有确定性测试 |
| 生产接线 | PASS（代码/IaC） | 独立 Onboarding API 与 Provisioning Lambda、EventBridge 分钟调度、KMS/IoT 权限及真实 AWS 适配器已接线 |
| 严格验收 | PASS（本地） | 2026-09-07 `pnpm verify` 退出 0：实现 986/986、契约 285/285、脚本 80/80；历史快照：2026-09-04 曾记录 DEC-017 聚焦 128/128、实现 683/683、契约 250/250、脚本 53/53，仅作时点证据 |

## 5. 对接说明（下游任务）

- **BE-ONB-04**：新证书首个合法 Heartbeat 后调用 `SecurePackageService.destroyPackage`（轮换场景）并将设备迁移 Onboarded；本任务领取成功已销毁密文并核销 Token；
- **部署接线**：CDK 已注入 IoT endpoint、KMS Key、数据库 Secret 和 AWS Account ID；发布前仍需在目标 AWS 环境执行部署后验证；
- **设备端**：领取到证书包后按 heartbeatInterval=60 上报首个 Heartbeat。

## 6. 未决风险

- 本地 mock 与 CDK synth 无法证明目标 AWS 账户中的 IoT/KMS/RDS 实际权限和网络路径，需按部署验证说明执行真实环境 Gate；
- 终态失败通过 `ONBOARDING_PROVISIONING_FAILED` Outbox 形成告警意图，生产告警消费者和通知渠道需由运维平台持续监控。
