# BE-CERT-02 Certificate Rotate API

2026-10-01 按 DEC-003@1.1.0 / DEC-026@1.0.0 更新。当前设备集成协议见 [Device API](../api/device-api.bio-nexa.com.md)。

`POST /api/v1/device/certificate/rotate` 使用当前 ACTIVE 设备证书认证，封闭请求必填 `currentCertificateId` 与 `csrPem`。设备自行生成新 RSA 2048+ 密钥并保留私钥，云端只签发该 CSR 公钥的项目 CA 证书，返回 certificateId、certificatePem、certificateChain、effectiveDate、expiryDate。新公钥不得等于当前公钥，跨设备公钥复用被持久所有权表拒绝。

新证由 RegisterCertificateWithoutCA 注册并附加原单设备 Policy/Thing；保存真实 X509 元数据。新旧证保持 ACTIVE 并行，新证 rotationDeadlineAt 为创建时刻加 24 小时；服务端按新证分别记录 MQTT/REST 验证时间，任意顺序均可。设备锁、证书锁和条件更新保证双通道确认只提交一次：撤销旧证、销毁公开包、完成管理员请求并写审计和持久 AWS 停用意图。已有 Sweeper 将旧证设为 INACTIVE，失败保留意图重试。

到达截止时未确认的新证立即在应用认证层拒绝；Sweeper 撤销新证及包并停用 AWS 新证，旧证保持原状态及有效期。证书签发后可捕获的失败会记录 REVOKED 孤证与停用意图；AWS 与数据库之间进程硬中断的孤证需运维核对，见实施验收风险。

一次交付回调在事务提交后使用根数据库客户端，避免访问已经结束的事务。交付结果不确定可撤销重签，已提交交付未完成双通道时返回 409。没有云端生成设备私钥的兼容分支。

验证：`pnpm vitest run apps/cloud-api/test/certificate-rotate.test.ts apps/cloud-api/test/device-sync.test.ts apps/ingestion-worker/test/rotation-confirmation.test.ts`；完整 Gate `pnpm verify`。测试采用 PGlite 全迁移与模拟 AWS，不能代替真实设备/AWS 验收。证据与部署前置条件见 [实施验收](../audit/设备证书CSR轮换与双通道确认实施验收-2026-10-01.md)。
