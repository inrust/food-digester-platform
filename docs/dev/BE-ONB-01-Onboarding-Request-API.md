# BE-ONB-01 Onboarding Request API

实现：[apps/cloud-api/src/onboarding](../../apps/cloud-api/src/onboarding)；契约：[device-onboarding-api.json](../../contracts/rest/device-onboarding-api.json)；测试：[csr-onboarding.test.ts](../../apps/cloud-api/test/csr-onboarding.test.ts)、[onboarding-contract-parity.test.ts](../../apps/cloud-api/test/onboarding-contract-parity.test.ts)。

`POST /api/v1/device/onboarding/request` 只接受设备资料与 `csrPem`，不使用 Bearer Token，也不查询设备库存。服务端校验字段和 CSR 自签名、RSA 公钥长度，并按来源 IP 和序列号限流。序列号从未提交则创建 `PENDING` 并返回 201；任何状态的已有申请均返回 409 CONFLICT，明确提示已提交、无需重复提交，不覆盖 CSR 或泄露原申请 ID。数据库全状态唯一索引防止并发重复；申请不提前创建设备或绑定公钥。缺 CSR、未知字段或 `Authorization` 请求头返回 400。

管理员批准时在审批事务内按申请资料创建设备台账、绑定公钥、写状态历史及持久化签发 Job。无库存申请可直接拒绝并保留原因，不创建设备。已有待接入台账保持资料与状态校验；跨设备公钥绑定冲突使审批和新台账整体回滚。

管理员审批由 BE-ONB-02 执行，状态轮询与证书签发由 BE-ONB-03 执行。审批只在按线下管理制度核对实物和申请后进行，CSR 只能证明私钥持有。数据库迁移删除旧 Token 表和关联列，要求 CSR 与公钥指纹非空；若开发库仍有旧式无 CSR 申请，迁移会失败，须先人工清理或核对数据，不能自动冒充为新申请。

本地测试、OpenAPI 和迁移检查不等于目标 AWS 或真实设备联调。接口示例与签名细节见 [设备对接文档](../api/onboard-api.bio-nexa.com.md)。
