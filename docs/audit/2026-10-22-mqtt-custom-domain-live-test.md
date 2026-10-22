# MQTT 自定义域名实测报告

测试日期：2026-10-22，北京时间。入口：`iot.bio-nexa.com:8883`，AWS 账号 `065986019555`，区域 `ap-southeast-1`（新加坡）。

**结论：自定义域名的 TLS、X.509 认证、MQTT CONNECT、三个下行 Topic 的 SUBACK 和保活均实测通过，AWS 服务端同步确认 `connected=true`。** 测试结束后已正常断开，临时 Thing、证书与策略均已删除并回查确认。本次发布业务消息为 **0 条**，业务收发和设备方真机联调仍为 **NOT RUN**。

## 1. 实测范围与身份

- 探测时间：北京时间 **18:12:44.007—18:13:17.473**（UTC `2026-10-22T10:12:44.007Z`—`2026-10-22T10:13:17.473Z`）。
- 临时 Client ID / Thing：`fdp-mqtt-probe-mvjdu7ag`，使用唯一身份，没有复用现有设备的 Client ID。
- 认证：本次临时创建的 **AWS 签发 X.509 测试证书**，在 IoT Core 激活并绑定独立 Thing 和逐设备策略；私钥仅保存在进程内存，未写入回执或仓库。
- 逐设备策略由仓库 [buildDevicePolicy](../../packages/aws-clients/src/iot-device-policy.ts) 构造，限制为该设备自身的 Client ID、8 类上行和 3 类下行 Topic。实际执行仅为连接、订阅和保活，没有向业务 Topic 发布消息。
- 客户端使用 MQTT 3.1.1、clean session、Keep Alive 5 秒，关闭自动重连；TLS SNI 为 `iot.bio-nexa.com`，启用证书链及主机名验证。Keep Alive 5 秒仅为本次短时探测参数，不修改固件协议基线。

本次没有通过项目 Onboarding CSR / 项目 CA 签发流程获取设备证书，也没有创建业务数据库设备台账。因此结论适用于自定义 MQTT 入口和测试身份的连接与订阅权限，不代表 Onboarding 证书闭环或真实固件验收。

## 2. 域名与服务端配置

[域名与 TLS 原始快照](./evidence/mqtt-custom-domain-2026-10-22/domain-and-tls.json) 采集于北京时间 18:10:14。

| 项目 | 实测结果 |
|---|---|
| IoT Domain Configuration | `bionexa-iot-prod` |
| 自定义域名 | `iot.bio-nexa.com` |
| 配置状态 / 服务端证书状态 | `ENABLED` / `VALID` |
| 认证 / 应用协议 | `AWS_X509` / `SECURE_MQTT` |
| 默认 Data-ATS 端点 | `a323xp2aswsptd-ats.iot.ap-southeast-1.amazonaws.com` |
| 自定义域名 TCP 8883 | `CONNECTED` |
| TLS | `TLSv1.3`，验证通过 |
| 服务端证书 CN / SAN | `iot.bio-nexa.com` |
| 服务端证书有效期 | `2026-10-22 00:00:00 UTC` 至 `2027-05-07 23:59:59 UTC` |

原始快照记录的是这次检查时点的状态；配置名中的 `prod` 不改变本报告的限定验收范围。

## 3. MQTT 连接与订阅结果

[完整连接回执](./evidence/mqtt-custom-domain-2026-10-22/connection.json) 中的 `tests` 记录如下：

| 检查项 | 关键字段或事件 | 结果 |
|---|---|---|
| 设备认证及 CONNECT | `connack.returnCode=0`，`connect.connected=true`；北京时间 18:13:00.428 | PASS |
| 客户端 TLS 验证 | `tls.authorized=true`，协议 `TLSv1.3`，服务端 CN 与 SNI 均为 `iot.bio-nexa.com` | PASS |
| 命令 Topic 订阅 | `bnx/device/fdp-mqtt-probe-mvjdu7ag/cmd`，SUBACK granted QoS `1` | PASS |
| OTA Topic 订阅 | `bnx/device/fdp-mqtt-probe-mvjdu7ag/ota`，SUBACK granted QoS `1` | PASS |
| 通知 Topic 订阅 | `bnx/device/fdp-mqtt-probe-mvjdu7ag/notification`，SUBACK granted QoS `1` | PASS |
| AWS 服务端会话确认 | `GetConnection` 返回 `connected=true`，Client ID 和 Thing 均与测试身份一致，目标端口 `8883` | PASS |
| MQTT 保活 | 收到 `PINGRESP`；北京时间 18:13:07.183 | PASS |
| 正常断开 | `disconnect.normalDisconnect=true` | PASS |

`connected=true` 是测试期间的服务端状态，测试已结束并清理，不能解释为该临时设备目前仍在线。SUBACK 证明订阅获准，本次未发送下行消息，所以不等于设备实际收到命令、OTA 或通知。

## 4. 临时资源清理

连接回执的 `cleanup` 六项均为 PASS：解绑 Policy、解绑 Thing Principal、停用证书、删除证书、删除 Policy、删除 Thing。

[清理后只读回查](./evidence/mqtt-custom-domain-2026-10-22/cleanup-readback.json) 采集于北京时间 **18:13:57.071917**。对同一临时 Thing、证书和 Policy 分别调用查询接口，均返回 `ResourceNotFoundException`，`allRemoved=true`。现有设备、策略和域名配置未被修改。

## 5. 业务收发与固件验收边界

| 验证层 | 本次结论 |
|---|---|
| DNS / TCP / 服务端 TLS / SNI | PASS |
| 临时 X.509 设备 MQTT CONNECT、三类下行订阅许可、保活 | PASS |
| 上行 8 类业务消息 PUBLISH / PUBACK | NOT RUN，发布消息数为 0 |
| 下行 cmd / ota / notification 实际投递及设备接收 | NOT RUN，订阅成功不能替代消息接收结果 |
| 消息 Schema、审计 Hash、IoT Rule → SQS → Worker → 数据库 / 归档 | 本次未执行业务消息，不形成该链路新验收结论 |
| 首 Heartbeat 激活、REST mTLS Sync、项目 CA 证书轮换双通道确认 | NOT RUN |
| 命令执行与 ACK、OTA 下载/安装/阶段 ACK、媒体上传闭环 | NOT RUN |
| 跨设备、通配 Topic、错误 Client ID 等拒绝用例 | NOT RUN |
| 设备方实际证书与固件、长时间稳定性、性能或生产验收 | NOT RUN |

设备方继续使用 Onboarding `APPROVED.mqtt.endpoint` 和运维明确的环境参数。当前 [Onboarding 入口](../../apps/cloud-api/src/runtime/device-onboarding-entry.ts) 仍通过 `iot.getDataEndpoint()` 取得默认 AWS 端点；自定义域名连接通过不等于 Onboarding 已切换为返回自定义主机。本次没有修改该行为，也没有核验部署代码与本地提交同 SHA。

下一步应由设备方使用真实 Onboarding 身份，通过明确的 Host/SNI 建立单一连接，发布合法 Heartbeat 并核对业务处理，再逐项验证八类上行、三类下行实际投递及任务闭环。

## 6. 证据文件与接口文档

- [连接与订阅回执](./evidence/mqtt-custom-domain-2026-10-22/connection.json)
- [域名配置与 TLS 快照](./evidence/mqtt-custom-domain-2026-10-22/domain-and-tls.json)
- [资源清理回查](./evidence/mqtt-custom-domain-2026-10-22/cleanup-readback.json)
- [原始回执 SHA-256 索引](./evidence/mqtt-custom-domain-2026-10-22/manifest.json)
- [本次文档与证据校验结果](./evidence/mqtt-custom-domain-2026-10-22/documentation-check.json)：原始回执一致性、Hash、状态字段、链接与敏感内容检查通过；MQTT 契约测试 72/72 通过。
- [MQTT 接口文档](../api/iot.bio-nexa.com.md) 与 [完整报文样例](../api/mqtt-message-examples.md)

原始回执按采集时内容保留；原始快照中出现的其他现有 Thing / 证书库存不是本次被测设备，不扩大本次结论。历史报告保留各自采集时点的结论，本次结果作为新的自定义域名连接证据。
