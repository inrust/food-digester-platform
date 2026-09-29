# BE-ONB-03 证书签发与 Onboarding Status API

实现：[provisioning](../../apps/cloud-api/src/provisioning)、[status-handler.ts](../../apps/cloud-api/src/onboarding/status-handler.ts)；契约：[device-onboarding-api.json](../../contracts/rest/device-onboarding-api.json)；测试：[provisioning.test.ts](../../apps/cloud-api/test/provisioning.test.ts)、[csr-onboarding.test.ts](../../apps/cloud-api/test/csr-onboarding.test.ts)。

管理员批准申请后，同事务创建持久化 Provisioning Job；Worker 按申请保存的 CSR 公钥，以项目 CA 签发设备叶证书，注册 AWS IoT Core，并完成 Policy/Thing 绑定。设备私钥只在设备本地，云端证书包只含 `certificatePem`，通过 KMS 信封加密短期保存。首次接入下发的同一张叶证书用于 IoT MQTT 和 Device REST mTLS。

`GET /api/v1/device/onboarding/status?requestId=...` 使用申请时 CSR 对应的私钥签名认证。设备提交 `X-Onboarding-Timestamp`、`X-Onboarding-Nonce`、`X-Onboarding-Signature`；服务端校验公钥指纹、签名、时间窗和随机数防重放。不接受 Bearer Token。完整签名原文、响应和错误码见[设备 API 文档](../api/onboard-api.bio-nexa.com.md)。

外部状态只有 `PENDING`、`REJECTED`、`APPROVED`。审批通过但发证尚未就绪时仍返回 `PENDING`；`APPROVED` 返回 `deviceId`、`certificate.certificatePem`、MQTT endpoint 和 `heartbeatInterval=60`，不返回私钥。证书包只允许一次成功领取，HTTP 响应提交后确认交付并销毁密文；领取不确定或包过期时撤销未确认证书后重签。首个合法 Heartbeat 才将设备置为 Onboarded。24 小时截止后的申请内部置 `TIMED_OUT`，对外返回 `REJECTED/ONBOARDING_TIMEOUT`。

本地测试覆盖 CSR 签名轮询、重放拒绝、审批后发证、幂等重试及证书包领取。目标 AWS 的 IoT/KMS/RDS 实际权限和网络路径仍需部署后验证；本地 mock 和 CDK synth 不能代替目标环境回执。
