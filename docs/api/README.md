# 设备入口 API 文档

本文档目录描述设备首次接入、运行数据通信和生命周期操作：

| 域名 | 认证边界 | 文档 |
|---|---|---|
| `onboard-api.bio-nexa.com` | 无需预置 Token；CSR 申请与私钥签名轮询 | [Onboarding API](./onboard-api.bio-nexa.com.md) |
| `device-api.bio-nexa.com` | API Gateway mTLS + 应用层设备证书白名单；接入后使用 | [Device API](./device-api.bio-nexa.com.md) |
| `iot.bio-nexa.com`（2026-10-22 连接实测通过；实际主机仍以 Onboarding 与运维参数为准） | MQTT over TLS + 设备 X.509；8 类上行、3 类下行 | [设备 MQTT 联调说明](./iot.bio-nexa.com.md) |

只有印刷序列号的设备使用 [无预置凭据 Onboarding 流程](./onboard-api.bio-nexa.com.md)。设备方与管理员须按线下制度核验申请与实物的对应关系。

管理后台及客户业务 API 使用 `api.bio-nexa.com`，不在本目录设备文档的范围内。持续上报心跳、传感器数据、报告和告警，以及接收命令/OTA/通知，请查阅 MQTT 联调说明；证书、同步、下载授权和媒体上传会话请查阅 Device REST API。

设备方需要完整报文时，可直接查阅 [设备 MQTT 完整报文样例](./mqtt-message-examples.md)，并使用其中链接的独立 JSON 文件对照开发。

## 契约来源与优先级

1. `docs/Device-Cloud-Communication-Design-解析.md`：设备通信源事实和原始六接口；
2. `contracts/rest/device-*.json`：当前可执行 OpenAPI 契约；
3. `apps/cloud-api/src/runtime/delivered-operations.ts` 与生产 Lambda 入口：域名实际路由和处理器接线；
4. `docs/管理后台开发任务清单.md`：任务边界、认证和验收要求。

字段、状态码或枚举发生冲突时，以仓库中通过契约检查的 OpenAPI 为集成基准；不得只依据本文示例放宽请求。正文未重复列出的全部 JSON Schema 约束可在相应 `contracts/rest` 文件中查询。

MQTT 以 `contracts/mqtt/topic-catalog.json`、各 Topic JSON Schema、冻结策略及业务处理器为准。新文档列明 Schema 之外的业务必填条件、序号幂等、Hash 算法和联调验收项目。

## 当前交付边界

MQTT 自定义域名 `iot.bio-nexa.com:8883` 的 TLS、临时 X.509 身份连接、三个下行订阅许可和保活已于 2026-10-22 实测通过，见 [连接实测报告](../audit/2026-10-22-mqtt-custom-domain-live-test.md)。另有 [8 类上行与 3 类下行业务实测](../audit/2026-10-22-mqtt-business-live-test.md)，在共享 test 环境使用独立软件设备和预置 fixture 核对了消息收发、云端状态和归档。

后续 [真实 CSR、首次激活及双通道轮换实测](../audit/2026-10-22-csr-lifecycle-live-test.md) 使用一台由申请、审批接口实际创建的软件设备，验证项目 CA 签发、签名领取、首次 Heartbeat 激活、REST Sync，以及 MQTT→REST / REST→MQTT 两种轮换确认顺序；核对了旧证 REST 拒绝、AWS IoT 停用和 MQTT 连接拒绝。该轮没有手工预置证书或修改生命周期，也未分配 Customer/Site/License；Sync 验证的是未分配设备快照。Onboarding 返回主机仍为既有 AWS Data-ATS 端点，本轮 MQTT 使用运维指定的自定义域名。

上一轮 [带业务分配的完整 REST Sync 实测](../audit/2026-10-22-rest-sync-live-test.md) 保留了运行状态 `ACTIVE` 与契约 `Active` 不一致的失败。后续 [状态修复、部署及隔离复测](../audit/2026-10-22-rest-sync-status-fix-live-test.md) 已验证新写入规范值、历史大写值读取兼容、真实 Heartbeat 恢复和 ETag 一致性：161/161 项检查通过，15 次成功 Sync 的 Schema 全部通过；Customer/Site、有效 License、配置和设备用户的九次完整快照比较匹配云端，测试资源已清理。MQTT 大写枚举保持原契约。

截至 2026-10-22，[独立 License HMAC 与业务激活前置核验](../audit/2026-10-22-license-hmac-activation-preflight.md)确认专用 verifier 角色不存在，运营尚未提供获权通道。目标独立验签和 `VERIFIED → Active` 为 **BLOCKED / NOT_RUN**；本地工具回归不替代目标证明，本轮未创建云资源。运营交付通道后按报告中的绑定与清理步骤继续。

设备方真实固件、独立 License HMAC 验签及 `VERIFIED → Active`、设备用户本地应用、实体业务动作、OTA 下载与安装、其余 REST 操作、24 小时轮换超时回退及生产验收仍为 **NOT RUN**；用户的 `ACKNOWLEDGED` 不代表已应用。各次限定通过范围以对应审计证据为准。

## 2026-10-01 证书契约升级

按 DEC-003@1.1.0 与 DEC-026@1.0.0，Onboarding `certificate` 增加必填 `certificateChain`，顶层增加 `rest.endpoint`；Rotate 必填 `csrPem`，返回 `certificateChain`，删除 `privateKey`。设备证书状态和管理端证书摘要增加 `mqttVerifiedAt`、`restVerifiedAt`、`rotationDeadlineAt`、`rotationConfirmedAt`，未知值为 `null`。这次轮换请求/响应是破坏性升级，固件与云端须一起切换；不保留云端生成设备私钥的兼容分支。

同一项目 CA 叶证书在 MQTT 和 Device REST 使用；首次接入保留首 Heartbeat 激活，轮换使用 24 小时双通道确认与超时回退。迁移步骤、旧记录处理和未执行的目标 Gate 见 [实施验收](../audit/设备证书CSR轮换与双通道确认实施验收-2026-10-01.md)。
