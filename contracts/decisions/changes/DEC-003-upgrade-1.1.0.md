# DEC-003 升级记录

变更类型：upgrade；1.0.0 → 1.1.0；批准人：业务方（本次明确实施授权）；时间：2026-10-01。

证书包内容冻结为 certificatePem + certificateChain，禁止 privateKey；保留 KMS 信封加密 86400 秒及一次提交后销包语义。新增 NEW_CERTIFICATE_DUAL_CHANNEL_VERIFIED 销包触发器，轮换确认遵循 DEC-026；Onboarding 首 Heartbeat 激活遵循 DEC-017，不等待 REST。

影响 SEC-01、BE-ONB-03、BE-CERT-02、REST 契约及固件。旧包缺 chain 必须撤销重签，不能补发私钥。变更后的前向兼容迁移与未执行目标 Gate 见实施验收报告；不允许静默回退私钥交付协议。
