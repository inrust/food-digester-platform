# BE-ONB-03 证书签发与 Onboarding Status API

实现：[apps/cloud-api/src/provisioning](../apps/cloud-api/src/provisioning)、[status-handler.ts](../apps/cloud-api/src/onboarding/status-handler.ts)；契约：[contracts/rest/device-onboarding-api.json](../contracts/rest/device-onboarding-api.json)（status 端点）；测试：[provisioning.test.ts](../apps/cloud-api/test/provisioning.test.ts)、[onboarding-status.test.ts](../apps/cloud-api/test/onboarding-status.test.ts)（PGlite 真实 PostgreSQL + 全部 migration + 内存 mock IoT Port）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ONB-03（P1 / 设备接口），依赖 BE-ONB-02、SEC-01、AUTH-04、DEC-003（均已交付） |
| 端点 | `GET /api/v1/device/onboarding/status`（Onboarding Token 认证，serialNumber 绑定校验） |
| 签发链 | approve（BE-ONB-02）→ `ProvisioningTrigger` 端口 → ensureThing → CreateKeysAndCertificate → AUTH-04 单设备 Policy → attach Policy/Thing → 证书记录 → SEC-01 信封加密封包 |
| 证书包 | DEC-003@1.0.0/SEC-01：KMS 信封加密保存 86400 秒、一次成功领取、成功响应提交后销毁；响应不确定、丢失或过期时吊销未确认新证书并重签 |
| 功能边界 | 内部 Provisioning 不暴露为外部状态（未就绪对外一律 PENDING）；不实现 CSR |

## 2. 模块组成

| 模块 | 内容 |
|---|---|
| `provisioning/iot-port.ts` | `IotProvisioningPort` 端口：ensureThing/ensurePolicy（按名幂等）、createKeysAndCertificate、attachPolicy/attachThingPrincipal；cloud-api 不依赖 AWS SDK，生产适配器在部署接线任务实现 |
| `provisioning/service.ts` | `ProvisioningService`：幂等短路（已有证书包 → replayed）；孤儿证书按 DEC-003 丢失处置 REVOKED 后重签；证书记录落库 + `onboarding.provision` 审计；私钥仅内存经过并立即封包 |
| `onboarding/status-handler.ts` | 三态映射：PENDING / REJECTED（含 rejectReason）/ APPROVED（一次性领取证书包：deviceId、certificatePem、privateKey、mqttEndpoint、heartbeatInterval=60；领取成功核销 Token） |
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
| 负向 | Token 无申请 404；缺序列号 400；伪造 Token 401 | ✅ |

`pnpm vitest run apps/cloud-api/test` 37/37 通过；全仓 `pnpm verify` 退出 0（2026-08-27）。

## 4. 对接说明（下游任务）

- **BE-ONB-04**：新证书首个合法 Heartbeat 后调用 `SecurePackageService.destroyPackage`（轮换场景）并将设备迁移 Onboarded；本任务领取成功已销毁密文并核销 Token；
- **部署接线**：生产需提供 `IotProvisioningPort` 的 AWS SDK 适配器（CreateThing/CreateKeysAndCertificate/CreatePolicy/AttachPolicy/AttachThingPrincipal）与 `mqttEndpoint`（IoT Data Endpoint）、`packageRetentionSeconds`（DEC-003 冻结值）；BE-ONB-02 处注入 `provisioningTrigger: provisioningService`；
- **设备端**：领取到证书包后按 heartbeatInterval=60 上报首个 Heartbeat。

## 5. 未决风险

- CreateKeysAndCertificate 成功但 DB 落库失败时，AWS 侧产生孤儿证书（无业务记录、无私钥泄露）；需运维侧定期清理无关联证书（可加 AWS 侧清单对账任务）；
- 生产接线必须从 `certificate-package-policy` 读取 `packageRetentionSeconds=86400`、`maxClaims=1`；当前仍由部署配置注入的路径需收敛，禁止使用其他值；
- Provisioning 在 approve 请求内同步执行，AWS 抖动会延长审批延迟；如需异步化可引入 Outbox（outbox_events 表已就绪），属后续可靠性增强。
