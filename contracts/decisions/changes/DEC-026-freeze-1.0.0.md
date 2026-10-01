# DEC-026 冻结记录

变更类型：register + freeze；目标版本 1.0.0；批准人：业务方（本次明确实施授权）；时间：2026-10-01。

冻结设备生成 CSR、公开叶证书及完整 CA chain、受控 deviceId Subject/SAN、跨设备公钥防复用、双通道验证时间、轮换 24 小时并行/超时回退及持久 AWS 停用重试。保留首次接入首 Heartbeat 激活与 RegisterCertificateWithoutCA。

影响 BE-ONB-03、BE-CERT-02/03、BE-SYNC-01、AUTH、SEC、DB、IAC、管理页面和 API 文档。轮换请求新增必填 CSR，响应删除 privateKey，是破坏性升级；实施、迁移、回滚限制及验收见 docs/audit/设备证书CSR轮换与双通道确认实施验收-2026-10-01.md。
