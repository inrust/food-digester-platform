# BE-ONB-01 Onboarding Request API

实现：[apps/cloud-api/src/onboarding](../../apps/cloud-api/src/onboarding)；契约：[device-onboarding-api.json](../../contracts/rest/device-onboarding-api.json)；测试：[csr-onboarding.test.ts](../../apps/cloud-api/test/csr-onboarding.test.ts)、[onboarding-contract-parity.test.ts](../../apps/cloud-api/test/onboarding-contract-parity.test.ts)。

`POST /api/v1/device/onboarding/request` 只接受设备资料与 `csrPem`，不使用 Bearer Token。设备私钥留在设备；服务端校验 CSR 自签名和 RSA 公钥长度，检查库存 `PendingOnboarding` 状态，按来源 IP 和序列号限流，然后创建 `PENDING` 申请。相同序列号与公钥重试返回原 `requestId`（200）；首次创建返回 201；同序列号换钥冲突返回 409。缺 CSR、未知字段或 `Authorization` 请求头返回 400。申请创建不审批、不签发证书，也没有 AWS 副作用。

管理员审批由 BE-ONB-02 执行，状态轮询与证书签发由 BE-ONB-03 执行。审批只在按线下管理制度核对实物和申请后进行，CSR 只能证明私钥持有。数据库迁移删除旧 Token 表和关联列，要求 CSR 与公钥指纹非空；若开发库仍有旧式无 CSR 申请，迁移会失败，须先人工清理或核对数据，不能自动冒充为新申请。

本地测试、OpenAPI 和迁移检查不等于目标 AWS 或真实设备联调。接口示例与签名细节见 [设备对接文档](../api/onboard-api.bio-nexa.com.md)。
