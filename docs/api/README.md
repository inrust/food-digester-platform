# 设备入口 API 文档

本文档目录描述设备使用的两个独立 HTTPS 入口：

| 域名 | 认证边界 | 文档 |
|---|---|---|
| `onboard-api.bio-nexa.com` | 无需预置 Token；CSR 申请与私钥签名轮询（旧 Token 迁移兼容） | [Onboarding API](./onboard-api.bio-nexa.com.md) |
| `device-api.bio-nexa.com` | API Gateway mTLS + 应用层设备证书白名单；接入后使用 | [Device API](./device-api.bio-nexa.com.md) |

只有印刷序列号的设备使用 [无预置凭据 Onboarding 流程](./onboard-api.bio-nexa.com.md)。设备方与管理员须按线下制度核验申请与实物的对应关系。

管理后台及客户业务 API 使用 `api.bio-nexa.com`，不在本目录两份文档的范围内。MQTT 使用 `iot.bio-nexa.com`，也不属于 HTTPS REST API。

## 契约来源与优先级

1. `docs/Device-Cloud-Communication-Design-解析.md`：设备通信源事实和原始六接口；
2. `contracts/rest/device-*.json`：当前可执行 OpenAPI 契约；
3. `apps/cloud-api/src/runtime/delivered-operations.ts` 与生产 Lambda 入口：域名实际路由和处理器接线；
4. `docs/管理后台开发任务清单.md`：任务边界、认证和验收要求。

字段、状态码或枚举发生冲突时，以仓库中通过契约检查的 OpenAPI 为集成基准；不得只依据本文示例放宽请求。正文未重复列出的全部 JSON Schema 约束可在相应 `contracts/rest` 文件中查询。

## 当前交付边界

仓库已将测试环境域名参数配置为上述两个生产式主机名，并具备 API Gateway、Lambda 路由及认证代码。本文仅证明仓库契约和代码接线，不证明 DNS、ACM、API Gateway mTLS、Truststore、数据库、IoT、KMS 或 S3 已在目标 AWS 环境成功部署。目标 AWS 运行验收：**NOT RUN / NO RECEIPT**。
