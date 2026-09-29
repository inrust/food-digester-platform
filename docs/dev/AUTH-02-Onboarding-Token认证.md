# AUTH-02 Onboarding 首次接入校验（CSR）

> 文件名保留历史任务编号以维持既有文档链接；当前实现**没有 Onboarding Token**。

首次申请无预置凭据。设备生成 RSA 2048 位或更强密钥和自签名 PKCS#10 CSR，`POST /api/v1/device/onboarding/request` 校验 CSR 签名、库存序列号及设备状态。管理员按线下制度确认申请对应实物后审批。`GET /api/v1/device/onboarding/status` 用申请的 CSR 公钥验证设备对方法、路径、`requestId`、时间戳和随机数的签名，五分钟时间窗与数据库唯一随机数约束阻止重放。

`packages/auth/src/onboarding/rate-limit.ts` 提供共享 PostgreSQL 限频；`apps/cloud-api/src/onboarding/` 实现 CSR 和轮询签名校验。生产按来源 IP、序列号和申请 ID 限流。数据库只保留申请 CSR、公钥指纹和轮询随机数 Hash，不存在 `onboarding_tokens` 表。申请、签名和审批的可执行字段约束见 [Onboarding OpenAPI](../../contracts/rest/device-onboarding-api.json) 与 [设备对接文档](../api/onboard-api.bio-nexa.com.md)。

本地测试涵盖 CSR 格式和签名、同公钥幂等、换公钥冲突、轮询签名错误与重放。线下实物核验不能由接口签名代替；目标 AWS 与真机验收仍需独立执行。

当前全仓证据命令：`pnpm openapi:bundle` 后执行 `pnpm verify`；真实设备和目标 AWS 验收另行留存回执。
