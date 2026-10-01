# 设备 MQTT 联调说明（`iot.bio-nexa.com`）

版本基线：2026-10-01。本文供设备固件、网关软件和云端联调人员使用，覆盖持续数据上报、命令接收、OTA 状态和通知处理。当前契约为 **8 类上行 + 3 类下行**。设备持续发送数据使用 MQTT；证书、同步、下载授权及媒体上传会话使用 [Device REST API](./device-api.bio-nexa.com.md)，首次接入使用 [Onboarding API](./onboard-api.bio-nexa.com.md)。

`iot.bio-nexa.com` 是规划的 IoT 自定义域名。**实际连接主机以 Onboarding `APPROVED` 响应中的 `mqtt.endpoint` 和运维提供的环境参数为准**；不能仅凭本文认定该域名已经部署。本文根据仓库契约和生产处理器整理，真实设备与目标 AWS 验收仍为 **NOT RUN / NO RECEIPT**。

## 1. 联调前准备与首次连接

设备方完成无 Token 的 CSR 申请；管理员核验并批准后，设备取得 `deviceId`、`certificate.certificatePem`、`mqtt.endpoint` 和 `configuration.heartbeatInterval`。设备私钥为生成 CSR 时保存在本地的私钥，首次接入云端不下发私钥。设备安装前确认公钥匹配。

| 项目 | 设备端填写/准备 | 说明 |
|---|---|---|
| 环境 | 运维给定的测试环境 | 主机、证书、设备库存及数据归属必须属于同一环境 |
| MQTT Host | `mqtt.endpoint` | 主机名，不带 `https://`、路径或端口；自定义域名须完成 DNS、IoT Domain Configuration 和证书配置 |
| 端口与传输 | 基线使用 MQTT over TLS，8883 | 443 或 WebSocket 如有需要，需另行确认认证和部署参数 |
| MQTT 版本 | 建议先按 3.1.1 联调 | 本文不依赖 MQTT 5 特性；协议选择是客户端建议，不是仓库冻结参数 |
| Client ID | **原样使用 `deviceId`** | 与 IoT Thing Name 一致，不能使用出厂序列号或任意自定义客户端 ID |
| 客户端证书 | `certificatePem` | Onboarding 签发且已在 IoT Core 注册、绑定本设备的 X.509 证书 |
| 客户端私钥 | 本地 CSR 对应私钥 | 不上传、不写入日志或工单 |
| 服务端信任根 | 运维提供、匹配连接主机的 CA | 用于验证 Broker 服务端证书；不要与设备证书签发 CA 或 REST Truststore 混淆 |
| TLS SNI | 与 MQTT Host 相同 | SDK/客户端必须正确发送 SNI，并验证服务端主机名 |
| QoS | 所有业务 Topic 使用 **1** | 原设计部分 Topic 写 QoS 2，AWS 实际契约统一适配为 1；仍保留业务 ACK 和幂等 |
| Retain | `false` | 当前单设备策略未授权 RetainPublish；禁止把运行数据或命令作为 retained message |
| 会话与保活 | 建议初次联调 clean session、Keep Alive 60 秒 | 不是正式冻结值；保活不等于业务 Heartbeat。掉线后恢复订阅和同步 |
| MQTT 用户名/密码 | X.509 基线无需填写 | 不使用 Cognito JWT、Onboarding Token 或 REST Authorization Header |

AWS 端口和认证组合见 [AWS 协议与认证说明](https://docs.aws.amazon.com/iot/latest/developerguide/protocols.html)。默认端点的 X.509 MQTT 443 需要 `x-amzn-mqtt-ca` ALPN；WSS 使用 SigV4 或 Custom Authorizer，不能直接套用本页的 X.509 TLS 连接方式。协议版本及会话能力见 [AWS MQTT 说明](https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html)。

首次连接顺序：

1. 安装证书，以 `deviceId` 为 Client ID 建立 TLS/MQTT 连接。
2. 订阅自身 `cmd`、`ota`、`notification` 三个完整 Topic，检查 SUBACK。
3. 发布一条字段合法、时间正确的 Heartbeat。首个合法 Heartbeat 经云端处理后，设备才从 `OnboardingApproved` 进入 `Onboarded`，证书记录进入 `ACTIVE`；仅连接成功或取得 PUBACK 不代表接入完成。
4. 此后用 mTLS 调用 Device REST Sync，取得最新归属、License、Configuration 和运行状态。正常数据联调前，管理员须完成 Customer/Site 分配；Telemetry、Report 及需要客户归属的信号消息在未分配时会被隔离。
5. 按同步配置持续上报并接收下行。业务激活、License 与 Entitlement 仍按 Sync 结果执行，不能把 `Onboarded` 当作业务已许可。

同一设备同时只保持一个使用该 Client ID 的测试连接，避免测试工具和固件互相替换连接。尚无本项目定义的 LWT 业务报文；不要自行把固定时间戳的 Last Will 当作 Heartbeat 发布。

## 2. Topic 总览与方向

所有 Topic 均为 `bnx/device/{deviceId}/{type}`。`deviceId` 大小写必须与服务端返回值一致。设备只能发布自身上行 Topic，只能订阅自身三个下行 Topic；不能订阅 `bnx/device/#`、`bnx/device/+/cmd`，不能访问其他设备或发布下行消息。

| 类型 | 完整 Topic | 设备动作 | 上报/触发时机 | 信封 | QoS |
|---|---|---|---|---|---|
| 心跳与在线状态 `heartbeat` | `bnx/device/{deviceId}/heartbeat` | 发布 | 默认 60 秒，之后按 Sync 配置 | `meta+data` | 1 |
| 传感器/运行数据 `telemetry` | `bnx/device/{deviceId}/telemetry` | 发布 | 默认 30 秒，之后按 Sync 配置 | `meta+audit+data` | 1 |
| ESG 报告 `report` | `bnx/device/{deviceId}/report` | 发布 | 每周期/每小时/每日 | `meta+audit+data` | 1 |
| 告警 `alarm` | `bnx/device/{deviceId}/alarm` | 发布 | 事件触发 | `meta+data` | 1 |
| 操作事件 `event` | `bnx/device/{deviceId}/event` | 发布 | 事件触发 | `meta+data` | 1 |
| 命令/OTA 回执 `ack` | `bnx/device/{deviceId}/ack` | 发布 | 命令执行或 OTA 状态变化后 | `meta+data` | 1 |
| 安全事件 `tamper` | `bnx/device/{deviceId}/tamper` | 发布 | 事件触发 | `meta+audit+data` | 1 |
| 媒体元数据 `media` | `bnx/device/{deviceId}/media` | 发布 | 事件触发 | `meta+data` | 1 |
| 远程命令 `cmd` | `bnx/device/{deviceId}/cmd` | 订阅/接收 | 按需 | `meta+data` | 1 |
| 升级任务 `ota` | `bnx/device/{deviceId}/ota` | 订阅/接收 | 按需 | `meta+data` | 1 |
| 业务通知 `notification` | `bnx/device/{deviceId}/notification` | 订阅/接收 | 按需 | `meta+data` | 1 |

Heartbeat 配置允许 10～900 秒、默认 60 秒；Telemetry 配置允许 5～3600 秒、默认 30 秒，依据 [Configuration V1](../../contracts/configuration/configuration-v1-policy.json)。Topic 目录中的 Telemetry “10～60 秒”是原始频率描述，不应覆盖已冻结配置范围。MQTT Keep Alive/PINGREQ 不代替 Heartbeat。

## 3. 公共报文、序号和完整性

报文为 UTF-8 JSON 对象，字段区分大小写，不使用数组或字符串作为顶层报文。上行只提交业务 `meta`、`data`，需要审计的类型再带 `audit`；不要添加 `deviceId`、`customerId`、`tenantId`、`siteId`、`iotTopic`、`iotPrincipal`、`iotDeviceId`、`iotType` 或 `iotReceivedAt`。身份和客户归属由证书、Topic 与台账解析，IoT Rule 的信封字段由云端注入。

| 字段 | 上行必填 | 下行必填 | 约束 |
|---|---|---|---|
| `meta.id` | 是 | 是 | 全局唯一消息 ID，1～128 字符，匹配 `^[A-Z0-9][A-Z0-9-]{0,127}$`；例如 `TEL-DEV001-10001` |
| `meta.ts` | 是 | 是 | UTC ISO 8601，`YYYY-MM-DDTHH:mm:ss[.SSS]Z`；不使用本地时间或数字时间戳 |
| `meta.seq` | 是 | 否 | 非负整数，同一设备、同一上行类型单调递增；持久保存，重启不能归零复用 |
| `meta.schemaVer` | 否 | 否 | 字符串 `数字.数字`，V1 缺省视为 `1.0`；建议明确发 `1.0`，不能任意升级为服务端未支持版本 |
| `data` | 是 | 是 | 本类型的封闭 JSON 对象，见后续字段表 |
| `audit.hash` | Telemetry/Report/Tamper 必填 | 不使用 | SHA-256、64 位小写十六进制，覆盖原始 `{meta,data}` 的 RFC 8785 规范化 UTF-8 字节 |

`heartbeat/alarm/event/ack/media/cmd/ota/notification` 不带 `audit`，额外添加会触发 Schema 拒绝。可选字段没有值时省略，不要用空串、`null` 或数字字符串替代；唯一显式允许 `null` 的业务字段是 `ack.data.errorCode`。未知字段也拒绝。

Topic 中的 `deviceId` 要原样保留；`meta.id` 另受大写字母/数字/连字符约束，实际 UUID 设备 ID 可在消息 ID 中使用大写形式，但不能据此改变 Topic 或 Client ID。不要把文档中的 `DEV001`、序号或静态时间戳当作实际值复用。

### 3.1 时间、重试与重复消息

- `meta.ts` 与 Broker 接收时间偏差默认不得超过 **300 秒**；配置以目标环境为准。设备先同步时钟。
- 云端上行幂等键为 `{deviceId}:{topicType}:{meta.seq}`。同键同内容只处理一次；同键不同内容触发 `PAYLOAD_CONFLICT`，不会覆盖已有记录。
- 同一消息重发保持 `meta.id`、`meta.ts`、`meta.seq`、`data` 和 `audit.hash` 完全一致；新测量/新事件使用新 ID 和递增序号。ACK 的命令回执和 OTA 状态共用同一 `ack` 序号空间。
- QoS 1 可能重复投递。**PUBACK 仅确认 Broker 收到消息，不确认字段校验、数据库写入或业务成功**；当前没有给每条上行返回业务入库结果的响应 Topic。
- 掉线后按退避和随机抖动重连，重新订阅下行并调用 Sync。重发队列应有容量和过期策略；不要承诺长时间离线数据可直接原样补传，超过时间窗的 `meta.ts` 会被隔离。也不要修改旧消息时间后复用其序号。历史补传需要另行约定，本协议没有开放设备补传 API。
- 使用持久化下行去重记录，尤其是执行过的命令；不能依赖 MQTT 包 ID、DUP 标志或下行可选 `seq` 防止重复执行。

### 3.2 `audit.hash` 计算

计算顺序：先构造最终 `meta` 和 `data` → 取精确对象 `{meta,data}` → 用 RFC 8785 JCS 序列化 → UTF-8 → SHA-256 → 小写 hex → 添加 `audit.hash`。不得对整个 MQTT 字符串、含 `audit` 的对象、普通带缩进 JSON 或服务端归一化后的对象计算。若添加/改变 `schemaVer`、时间、序号、任何数据值，必须重算。

```text
subject = {meta: payload.meta, data: payload.data}
canonical = RFC8785_JCS(subject)
payload.audit = {hash: SHA256(UTF8(canonical)).lowercaseHex()}
```

完整向量使用下方 Telemetry/Report/Tamper 示例：其 `audit.hash` 与展示的 `meta`、`data` 已配套计算。使用语言对应的 JCS 实现处理数值、字符串转义和键排序；不要凭字典遍历顺序计算。该 Hash 用于完整性核验，不是设备数字签名；身份与幂等另由证书/Topic/序号保证。[规范化算法](../../contracts/mqtt/payload-normalization.ts)、[公共 Schema](../../contracts/mqtt/schemas/common.schema.json)。

## 4. 上行：设备向云端发布

每节字段表仅列 `data`；公共信封按第 3 节执行。“Schema 必填”与“业务必填”分别指 JSON Schema 的 required 和当前处理器追加检查，二者都须满足。其余字段存在时仍需符合类型、范围与枚举。

### 4.1 `heartbeat` — 心跳与在线状态

发布 `bnx/device/{deviceId}/heartbeat`，QoS 1。

正式字段使用扁平结构，模式使用 `DISCHARGING`。不要使用原 PDF 的 `network/system/machine/sensorStatus` 嵌套示例或 `DISCHARING` 拼写。当前代码有独立 DEC-013 格式兼容窗口，但新固件直接使用本页正式格式。设备自报状态不覆盖服务器的生命周期、授权或 License。

Heartbeat 与 REST Sync 的状态枚举不同：Sync 可返回 `Active`、`Maintenance` 等，License 可返回 `NO_LICENSE` 等；不能把这些值原样复制到 Heartbeat。目前 Heartbeat 没有 `MAINTENANCE` 或 `NO_LICENSE` 值，而 `operationalStatus`、`licenseStatus` 必填。未许可的首次接入及维护状态如何表达，属于现行契约仍需双方明确的映射；不要为通过校验而把未许可状态伪报成 `ACTIVE`。下面示例只演示真实处于 Active/License Active 的设备。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `deviceStatus` | `string` | Schema 必填 | `ONLINE`、`DEGRADED`、`OFFLINE` | 设备连接/健康状态 |
| `uptimeSeconds` | `integer` | Schema 必填 | ≥ 0 | 开机时长，秒 |
| `firmwareVersion` | `string` | Schema 必填 | 非空 | 固件版本 |
| `operationalStatus` | `string` | Schema 必填 | `ACTIVE`、`SUSPENDED`、`RETIRED` | 设备运行状态；与 Sync 的大小写和取值不同，见本节说明 |
| `machineRunning` | `boolean` | Schema 必填 | — | 是否运行 |
| `machineMode` | `string` | Schema 必填 | `IDLE`、`PROCESSING`、`HEATING`、`DISCHARGING`、`STOPPED`、`ERROR` | 机器工作模式 |
| `licenseStatus` | `string` | Schema 必填 | `ACTIVE`、`EXPIRING`、`EXPIRED`、`REVOKED` | 设备本地 License 状态 |
| `licenseExpiryDate` | `string` | 可选 | UTC `YYYY-MM-DD` | License 到期日 |
| `networkType` | `string` | Schema 必填 | 非空 | 网络类型，如 4G/WIFI，非封闭枚举 |
| `networkStatus` | `string` | Schema 必填 | `CONNECTED`、`WEAK`、`DISCONNECTED` | 网络健康状态 |
| `signalStrength` | `integer` | 可选 | — | 信号强度；单位/量程需设备方明确 |
| `cpuUsagePct` | `number` | 可选 | ≥ 0；≤ 100 | CPU 使用率，% |
| `memoryUsagePct` | `number` | 可选 | ≥ 0；≤ 100 | 内存使用率，% |
| `storageUsagePct` | `number` | 可选 | ≥ 0；≤ 100 | 存储使用率，% |
| `sensorOverallStatus` | `string` | Schema 必填 | `NORMAL`、`WARNING`、`FAILED` | 传感器总体状态 |
| `temperatureSensor` | `string` | 可选 | `NORMAL`、`WARNING`、`FAILED` | 温度传感器状态 |
| `humiditySensor` | `string` | 可选 | `NORMAL`、`WARNING`、`FAILED` | 湿度传感器状态 |
| `weightSensor` | `string` | 可选 | `NORMAL`、`WARNING`、`FAILED` | 称重传感器状态 |
| `gasSensor` | `string` | 可选 | `NORMAL`、`WARNING`、`FAILED` | 气体传感器状态 |
| `certificateStatus` | `string` | 可选 | `VALID`、`EXPIRING`、`EXPIRED`、`REVOKED` | 设备本地证书状态；VALID 与 REST ACTIVE 名称不同 |
| `tamperStatus` | `string` | 可选 | 非空 | 安全健康状态，如 NORMAL |

示例（Topic：`bnx/device/DEV001/heartbeat`）：

```json
{
  "meta": {
    "id": "HB-DEV001-100",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 100
  },
  "data": {
    "deviceStatus": "ONLINE",
    "uptimeSeconds": 86400,
    "firmwareVersion": "1.0.5",
    "operationalStatus": "ACTIVE",
    "machineRunning": true,
    "machineMode": "PROCESSING",
    "licenseStatus": "ACTIVE",
    "licenseExpiryDate": "2027-12-31",
    "networkType": "4G",
    "networkStatus": "CONNECTED",
    "signalStrength": -68,
    "cpuUsagePct": 25,
    "memoryUsagePct": 40,
    "storageUsagePct": 30,
    "sensorOverallStatus": "NORMAL",
    "temperatureSensor": "NORMAL",
    "humiditySensor": "NORMAL",
    "weightSensor": "NORMAL",
    "gasSensor": "NORMAL",
    "certificateStatus": "VALID",
    "tamperStatus": "NORMAL"
  }
}
```

[完整 Schema](../../contracts/mqtt/schemas/heartbeat.schema.json) · [正负样例](../../contracts/mqtt/fixtures/heartbeat.fixtures.json)

### 4.2 `telemetry` — 传感器/运行数据

发布 `bnx/device/{deviceId}/telemetry`，QoS 1。

13 项指标均为 Schema 可选；应发送实际采集的指标，缺测时省略，不能用 0 表示缺测。当前没有耗材百分比字段；不要自行添加。正式电流字段为 `currentAmp`。云端将合法数据写入小时聚合并进入原文归档链路；未分配客户的消息会隔离。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `feedingWeightKg` | `number` | 可选 | ≥ 0 | 投料重量，kg |
| `chamberWeightKg` | `number` | 可选 | ≥ 0 | 腔体重量，kg |
| `dischargeWeightKg` | `number` | 可选 | ≥ 0 | 排料重量，kg |
| `humidityPct` | `number` | 可选 | ≥ 0；≤ 100 | 湿度，% |
| `ambientTempC` | `number` | 可选 | — | 环境温度，°C |
| `heatTemperatureC` | `number` | 可选 | — | 加热温度，°C |
| `siloTemperatureC` | `number` | 可选 | — | 料仓温度，°C |
| `powerConsumptionKw` | `number` | 可选 | ≥ 0 | 功率，kW；不是累计电能 kWh |
| `o2Pct` | `number` | 可选 | ≥ 0；≤ 100 | 氧气浓度，% |
| `co2Ppm` | `number` | 可选 | ≥ 0 | 二氧化碳浓度，ppm |
| `ch4Ppm` | `number` | 可选 | ≥ 0 | 甲烷浓度，ppm |
| `n2oPpm` | `number` | 可选 | ≥ 0 | 氧化亚氮浓度，ppm |
| `currentAmp` | `number` | 可选 | ≥ 0 | 电流，A |

示例（Topic：`bnx/device/DEV001/telemetry`）：

```json
{
  "meta": {
    "id": "TEL-DEV001-10001",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 10001
  },
  "audit": {
    "hash": "40f047e3f006218d289da25b59c4030361d448b51ce2cbb27c58bc28e089c3c9"
  },
  "data": {
    "feedingWeightKg": 25,
    "chamberWeightKg": 120,
    "dischargeWeightKg": 5,
    "humidityPct": 45.2,
    "ambientTempC": 28.5,
    "heatTemperatureC": 72.1,
    "siloTemperatureC": 62.5,
    "powerConsumptionKw": 2.8,
    "o2Pct": 20.5,
    "co2Ppm": 420,
    "ch4Ppm": 12,
    "n2oPpm": 1.5,
    "currentAmp": 3.8
  }
}
```

[完整 Schema](../../contracts/mqtt/schemas/telemetry.schema.json) · [正负样例](../../contracts/mqtt/fixtures/telemetry.fixtures.json)

### 4.3 `report` — ESG 报告

发布 `bnx/device/{deviceId}/report`，QoS 1。

业务必须提供 `reportType`、`periodStartTime`、`periodEndTime`；结束不能早于开始，同设备同类型的统计期间不得重叠。同期间起点的报告重投会跳过，不作为修订覆盖。`meta.ts` 是发送事件时间，历史统计期间可以在 `data` 表达，但依然须满足发送时间窗。设备计算值及示例 `DEFAULT_V1` 不代表第三方核证或正式计算方法已获认可。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `reportType` | `string` | 业务必填 | `CYCLE`、`HOURLY`、`DAILY` | 报告周期类型 |
| `periodStartTime` | `string` | 业务必填 | UTC 时间格式 | 统计起点，UTC |
| `periodEndTime` | `string` | 业务必填 | UTC 时间格式 | 统计终点，UTC |
| `feedingWeightKg` | `number` | 可选 | ≥ 0 | 投料重量，kg |
| `dischargeWeightKg` | `number` | 可选 | ≥ 0 | 排料重量，kg |
| `reductionWeightKg` | `number` | 可选 | ≥ 0 | 减量重量，kg |
| `cycleCount` | `integer` | 可选 | ≥ 0 | 处理周期数 |
| `processingDurationMinutes` | `number` | 可选 | ≥ 0 | 处理时长，分钟 |
| `energyConsumptionKwh` | `number` | 可选 | ≥ 0 | 累计电能，kWh |
| `averagePowerKw` | `number` | 可选 | ≥ 0 | 平均功率，kW |
| `averageO2Pct` | `number` | 可选 | ≥ 0；≤ 100 | 平均氧气浓度，% |
| `averageCo2Ppm` | `number` | 可选 | ≥ 0 | 平均二氧化碳，ppm |
| `averageCh4Ppm` | `number` | 可选 | ≥ 0 | 平均甲烷，ppm |
| `averageN2oPpm` | `number` | 可选 | ≥ 0 | 平均氧化亚氮，ppm |
| `carbonReductionKg` | `number` | 可选 | — | 减碳量，kg |
| `carbonReductionMethod` | `string` | 可选 | 非空 | 设备计算方法版本，如 DEFAULT_V1 |
| `dataCompletenessPct` | `number` | 可选 | ≥ 0；≤ 100 | 数据完整率，% |
| `missingRecordCount` | `integer` | 可选 | ≥ 0 | 缺失记录数 |

示例（Topic：`bnx/device/DEV001/report`）：

```json
{
  "meta": {
    "id": "RPT-DEV001-20001",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 20001
  },
  "audit": {
    "hash": "6aac8bc7e9c6d76c3c4bb91ee65164162b01d3c9e96ebfa85b15122023ac179c"
  },
  "data": {
    "reportType": "DAILY",
    "periodStartTime": "2026-09-30T00:00:00Z",
    "periodEndTime": "2026-09-30T23:59:59Z",
    "feedingWeightKg": 250,
    "dischargeWeightKg": 180,
    "reductionWeightKg": 70,
    "cycleCount": 12,
    "processingDurationMinutes": 480,
    "energyConsumptionKwh": 18.5,
    "averagePowerKw": 2.4,
    "averageO2Pct": 20.4,
    "averageCo2Ppm": 430,
    "averageCh4Ppm": 11,
    "averageN2oPpm": 1.4,
    "carbonReductionKg": 35.6,
    "carbonReductionMethod": "DEFAULT_V1",
    "dataCompletenessPct": 99.8,
    "missingRecordCount": 2
  }
}
```

[完整 Schema](../../contracts/mqtt/schemas/report.schema.json) · [正负样例](../../contracts/mqtt/fixtures/report.fixtures.json)

### 4.4 `alarm` — 告警

发布 `bnx/device/{deviceId}/alarm`，QoS 1。

业务必须提供 `code` 与 `status`。`ACTIVE` 激活告警；解除时发新序号、相同 `code` 与 `CLEARED`，云端关闭本设备该代码的全部活动告警。重复解除无活动告警时为幂等无操作。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `code` | `string` | 业务必填 | 非空 | 告警代码，激活与解除使用同一代码 |
| `category` | `string` | 可选 | 非空 | 告警分类 |
| `severity` | `string` | 可选 | `INFO`、`WARNING`、`HIGH`、`CRITICAL` | 严重度 |
| `status` | `string` | 业务必填 | `ACTIVE`、`CLEARED` | 状态，含义见本节 |
| `detectedTime` | `string` | 可选 | UTC 时间格式 | 发生/解除时刻，UTC；省略时用 meta.ts |
| `component` | `string` | 可选 | 非空 | 涉及部件 |
| `currentValue` | `number` | 可选 | — | 当前测量值 |
| `threshold` | `number` | 可选 | — | 阈值 |
| `unit` | `string` | 可选 | 非空 | 测量值单位 |
| `message` | `string` | 可选 | 非空 | 说明文本 |
| `recommendedAction` | `string` | 可选 | 非空 | 建议处理动作 |

示例（Topic：`bnx/device/DEV001/alarm`）：

```json
{
  "meta": {
    "id": "ALM-DEV001-30001",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 30001
  },
  "data": {
    "code": "TEMP_HIGH",
    "category": "TEMPERATURE",
    "severity": "HIGH",
    "status": "ACTIVE",
    "detectedTime": "2026-10-01T08:00:00Z",
    "component": "HEATER",
    "currentValue": 88,
    "threshold": 80,
    "unit": "C",
    "message": "Heating temperature exceeded threshold",
    "recommendedAction": "CHECK_HEATER"
  }
}
```

[完整 Schema](../../contracts/mqtt/schemas/alarm.schema.json) · [正负样例](../../contracts/mqtt/fixtures/alarm.fixtures.json)

### 4.5 `event` — 操作事件

发布 `bnx/device/{deviceId}/event`，QoS 1。

用于操作历史，与 Alarm 不同，不会自动创建告警。建议提供事件类型、来源及可用的操作者信息；业务 `userId` 不替代设备证书身份。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `eventType` | `string` | 可选 | 非空 | 事件类型；当前为非空字符串 |
| `userId` | `string` | 可选 | 非空 | 设备本地业务操作用户标识，不是设备认证身份 |
| `username` | `string` | 可选 | 非空 | 操作用户名 |
| `source` | `string` | 可选 | `LOCAL`、`REMOTE` | 操作来源 |
| `remarks` | `string` | 可选 | — | 备注 |

示例（Topic：`bnx/device/DEV001/event`）：

```json
{
  "meta": {
    "id": "EVT-DEV001-40001",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 40001
  },
  "data": {
    "eventType": "MACHINE_STARTED",
    "userId": "USR001",
    "username": "operator01",
    "source": "LOCAL",
    "remarks": "Daily operation start"
  }
}
```

[完整 Schema](../../contracts/mqtt/schemas/event.schema.json) · [正负样例](../../contracts/mqtt/fixtures/event.fixtures.json)

### 4.6 `tamper` — 安全事件

发布 `bnx/device/{deviceId}/tamper`，QoS 1。

用于安全事件，必须带 `audit.hash`。当前 `CRITICAL` 严重度会触发符合条件的 Active 设备自动挂起及审计。不要在正式生产设备上用高严重度报文随意测试。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `eventType` | `string` | 可选 | 非空 | 事件类型；当前为非空字符串 |
| `severity` | `string` | 可选 | `INFO`、`WARNING`、`HIGH`、`CRITICAL` | 严重度 |
| `component` | `string` | 可选 | 非空 | 涉及部件 |
| `details` | `string` | 可选 | — | 安全事件详情 |
| `actionTaken` | `string` | 可选 | 非空 | 设备已采取的动作 |

示例（Topic：`bnx/device/DEV001/tamper`）：

```json
{
  "meta": {
    "id": "TMP-DEV001-60001",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 60001
  },
  "audit": {
    "hash": "1950437b886b9ff3c44e717cc173fa87fb88800b4cb873a175fffa67c7116286"
  },
  "data": {
    "eventType": "ROOT_DETECTED",
    "severity": "CRITICAL",
    "component": "ANDROID_OS",
    "details": "Root binary detected",
    "actionTaken": "DEVICE_SUSPENDED"
  }
}
```

[完整 Schema](../../contracts/mqtt/schemas/tamper.schema.json) · [正负样例](../../contracts/mqtt/fixtures/tamper.fixtures.json)

### 4.7 `ack` — 命令/OTA 回执

发布 `bnx/device/{deviceId}/ack`，QoS 1。

**命令分支**：`objectType=COMMAND`，必须有 `commandId`、`command`，且与原命令和设备匹配；不得混入 `otaTargetId/status`。`result` 省略表示收到确认，执行完成后用新 ACK 序号报告 `SUCCESS` 或 `FAILED`。

**OTA 分支**：`objectType=OTA_TARGET`，必须有 `otaTargetId`、`status`；不得混入 `commandId/command/result/executeTimeMs`。两个分支都没有新建专用回执 Topic。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `objectType` | `string` | Schema 必填 | `COMMAND`、`OTA_TARGET` | COMMAND 或 OTA_TARGET，决定回执分支 |
| `commandId` | `string` | 对应分支业务必填 | 非空 | 原 cmd.meta.id；逐字符回传 |
| `command` | `string` | 对应分支业务必填 | 命令白名单（第 5.1 节） | 原命令名，按白名单且与原任务一致 |
| `result` | `string` | 可选 | `SUCCESS`、`FAILED` | 命令执行结果；省略仅表示收到确认 |
| `executeTimeMs` | `integer` | 可选 | ≥ 0 | 命令执行耗时，毫秒 |
| `otaTargetId` | `string` | 对应分支业务必填 | 非空 | 原始 OTA Target ID，取下载 URL 的目标路径段 |
| `status` | `string` | 对应分支业务必填 | `DOWNLOADING`、`INSTALLING`、`SUCCEEDED`、`FAILED`、`ROLLED_BACK` | 状态，含义见本节 |
| `errorCode` | `string/null` | 可选 | — | 错误代码；明确允许 null |
| `message` | `string` | 可选 | — | 说明文本 |

示例（Topic：`bnx/device/DEV001/ack`）：

```json
{
  "meta": {
    "id": "ACK-DEV001-50001",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 50001
  },
  "data": {
    "objectType": "COMMAND",
    "commandId": "CMD-DEV001-6001",
    "command": "START",
    "result": "SUCCESS",
    "executeTimeMs": 523,
    "errorCode": null,
    "message": "Machine Started"
  }
}
```

示例（Topic：`bnx/device/DEV001/ack`）：

```json
{
  "meta": {
    "id": "ACK-DEV001-50002",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 50002
  },
  "data": {
    "objectType": "OTA_TARGET",
    "otaTargetId": "OTATGT001",
    "status": "DOWNLOADING",
    "errorCode": null,
    "message": "Download started"
  }
}
```

[完整 Schema](../../contracts/mqtt/schemas/ack.schema.json) · [正负样例](../../contracts/mqtt/fixtures/ack.fixtures.json)

### 4.8 `media` — 媒体元数据

发布 `bnx/device/{deviceId}/media`，QoS 1。

只上报元数据，不通过 MQTT 发送图片/视频二进制或 Base64。先调用 Device REST `POST /api/v1/device/media/upload-sessions` → 按响应预签名 URL 和约束上传文件 → 在会话有效期内发布本 Topic。业务强制媒体类型、采集时间、合法文件名、服务端给定对象路径及大小；云端验证会话、归属、对象存在、大小和文件 Hash。示例路径只演示结构，须替换成真实会话的 `objectPath`；不能照抄 Schema fixture 中的 `s3://bucket/path`。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `mediaType` | `string` | 业务必填 | `IMAGE`、`VIDEO` | 媒体类型 |
| `captureTime` | `string` | 业务必填 | UTC 时间格式 | 采集时刻，UTC |
| `fileName` | `string` | 业务必填 | 非空；业务仅 `[A-Za-z0-9._-]`，1～128 字符 | 上传会话对应文件名 |
| `objectPath` | `string` | 业务必填 | 非空 | 原样使用上传会话返回的 objectPath |
| `sizeKb` | `number` | 业务必填 | ≥ 0 | 大小，KB；业务与会话一致，按 ceil(bytes/1024) |
| `durationSec` | `number` | 可选 | ≥ 0 | 视频时长，秒；图片可发 0 |

示例（Topic：`bnx/device/DEV001/media`）：

```json
{
  "meta": {
    "id": "MED-DEV001-70001",
    "ts": "2026-10-01T08:00:00Z",
    "seq": 70001
  },
  "data": {
    "mediaType": "IMAGE",
    "captureTime": "2026-10-01T07:59:55Z",
    "fileName": "capture-001.jpg",
    "objectPath": "media/CUS001/DEV001/MEDSES001/capture-001.jpg",
    "sizeKb": 120,
    "durationSec": 0
  }
}
```

[完整 Schema](../../contracts/mqtt/schemas/media.schema.json) · [正负样例](../../contracts/mqtt/fixtures/media.fixtures.json)

## 5. 下行：云端向设备发布

在同一 MQTT 连接订阅自身三个完整 Topic。下行 `meta.seq` 可省略；固件不能因为缺失 `seq` 拒绝消息。云端复投与设备重连可能导致重复，按业务 ID 去重，并检查当前运行状态与执行时效。

### 5.1 `cmd` — 远程命令

订阅 `bnx/device/{deviceId}/cmd`，QoS 1。`meta.id` 就是 `commandId`，设备 ACK 中必须逐字符回传。先校验命令、时效、设备状态与安全条件，再执行并发布命令 ACK；超时或重复收到的启动、排料等命令不得再次执行。命令过期时刻按 `requestTime + timeoutSec` 判断，设备时钟必须可靠。

收到确认不等于执行成功；如发送无 `result` 的接收确认，随后仍需发送最终执行结果。设备对重复 `meta.id` 返回已有结果或当前进度，避免重新执行；云端已经超时/终态的迟到回执只记事件，不会把超时任务改成功。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `command` | `string` | Schema 必填 | 命令白名单（第 5.1 节） | 要执行的命令名称；ACK 中回传相同值 |
| `requestedBy` | `string` | 可选 | 非空 | 发起者标识，不作为设备端权限证明 |
| `requestTime` | `string` | Schema 必填 | UTC 时间格式 | 命令发起时刻，UTC |
| `timeoutSec` | `integer` | Schema 必填 | ≥ 1 | 命令时效，秒 |
| `remarks` | `string` | 可选 | — | 备注 |

示例（Topic：`bnx/device/DEV001/cmd`）：

```json
{
  "meta": {
    "id": "CMD-DEV001-6001",
    "ts": "2026-10-01T08:00:00Z"
  },
  "data": {
    "command": "START",
    "requestedBy": "tenant_admin",
    "requestTime": "2026-10-01T08:00:00Z",
    "timeoutSec": 30,
    "remarks": "Start processing batch"
  }
}
```

V1 命令白名单及状态范围：

| 设备运行状态 | 可执行命令（仍须通过本地安全条件） |
|---|---|
| `ACTIVE` | 下表全部 22 个 |
| `SUSPENDED` / `MAINTENANCE` | `STOP`、`EMERGENCY_STOP`、`AGITATOR_STOP`、`HEATING_OFF`、`EXHAUST_OFF`、`AIR_SUPPLY_OFF`、`DISCHARGE_STOP`、`REBOOT`、`SHUTDOWN`、`TAKE_SNAPSHOT`、`FORCE_SYNC` |
| `RETIRED` | 拒绝全部 |
| 分类 | 命令 |
|---|---|
| MACHINE | `START`、`STOP`、`PAUSE`、`RESUME`、`EMERGENCY_STOP` |
| MOTOR | `AGITATOR_FORWARD`、`AGITATOR_REVERSE`、`AGITATOR_STOP` |
| HEATING | `HEATING_ON`、`HEATING_OFF`、`SET_TARGET_TEMPERATURE` |
| VENTILATION | `EXHAUST_ON`、`EXHAUST_OFF`、`AIR_SUPPLY_ON`、`AIR_SUPPLY_OFF` |
| DISCHARGE | `DISCHARGE_START`、`DISCHARGE_STOP` |
| DEVICE | `REBOOT`、`SHUTDOWN`、`FACTORY_RESET`、`TAKE_SNAPSHOT`、`FORCE_SYNC` |

当前 `cmd.data` 没有通用 `parameters` 或温度目标字段，即使命令名为 `SET_TARGET_TEMPERATURE` 也不能额外添加参数。具体设备执行策略需双方确认；不要从命令名推测不存在的报文字段。`requestedBy` 是审计信息，不是设备授权凭据。

[命令白名单/高风险与状态矩阵](../../contracts/mqtt/command-catalog.json) · [Command Schema](../../contracts/mqtt/schemas/cmd.schema.json) · [命令回执](#47-ack--命令ota-回执)

### 5.2 `ota` — 升级任务

订阅 `bnx/device/{deviceId}/ota`，QoS 1。实际云端发布版本、包类型、下载授权、文件摘要和强制标记；`scheduledTime` 按任务可选。按计划与当前状态执行，校验下载文件 SHA-256 后才安装，并用 ACK 回传每阶段结果。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `version` | `string` | 可选 | 非空 | 目标版本 |
| `packageType` | `string` | 可选 | `APP`、`FIRMWARE` | 升级包类型 |
| `downloadUrl` | `string` | 可选 | 以 `https://` 开头 | 一次性、绑定设备与目标的 HTTPS 下载授权 URL |
| `sha256` | `string` | 可选 | 64 位十六进制 | 下载文件 SHA-256，64 位 hex，大小写均可 |
| `mandatory` | `boolean` | 可选 | — | 是否强制升级 |
| `scheduledTime` | `string` | 可选 | UTC 时间格式 | 计划执行时刻，UTC，可省略 |

示例（Topic：`bnx/device/DEV001/ota`）：

```json
{
  "meta": {
    "id": "OTA-OTATGT001",
    "ts": "2026-10-01T08:00:00Z"
  },
  "data": {
    "version": "2.1.0",
    "packageType": "FIRMWARE",
    "downloadUrl": "https://device-api.bio-nexa.com/api/v1/device/ota/targets/OTATGT001/download?token=example-download-grant-for-test-only",
    "sha256": "ABC123DEF4567890ABC123DEF4567890ABC123DEF4567890ABC123DEF4567890",
    "mandatory": false,
    "scheduledTime": "2026-10-01T09:00:00Z"
  }
}
```

当前发布器 `meta.id = OTA-${otaTargetId.toUpperCase()}`，用于下行稳定去重。**原始 `otaTargetId` 从 `downloadUrl` 中 `/api/v1/device/ota/targets/{targetId}/download` 路径段提取并 URL 解码**，逐字符保存并回传；不要去掉 `OTA-` 后把大写 `meta.id` 当作原始目标 ID。示例中目标 ID 为 `OTATGT001`。

下载使用设备 mTLS，REST 成功响应为 307，再跟随 HTTPS `Location` 下载；一次性 grant 不能缓存或复用，完整规则见 [OTA 下载 REST API](./device-api.bio-nexa.com.md#get-apiv1deviceotatargetstargetiddownload)。下载授权不是 Onboarding Token；重连后下载授权已失效时不能无限重复兑换，应由云端重新安排有效授权。

OTA 状态只发布到 `bnx/device/{deviceId}/ack`：

| 当前云端目标状态 | 允许下一个设备回执状态 |
|---|---|
| `NOTIFIED` | `DOWNLOADING`、`FAILED` |
| `DOWNLOADING` | `INSTALLING`、`FAILED` |
| `INSTALLING` | `SUCCEEDED`、`FAILED`、`ROLLED_BACK` |
| `SUCCEEDED` | `ROLLED_BACK` |
| `FAILED` / `ROLLED_BACK` | 无后续状态 |

`NOTIFIED` 是云端状态，不是设备上报枚举；没有 `DOWNLOADED` 状态。相同目标相同状态的重复回执不产生新的状态迁移；新的阶段使用递增 ACK 序号。不得新建 `ota/status` Topic 或改用 IoT Jobs 状态 API。

[OTA Schema](../../contracts/mqtt/schemas/ota.schema.json) · [ACK 状态契约](../../contracts/mqtt/ota-status-channel-policy.json)

### 5.3 `notification` — 业务通知

订阅 `bnx/device/{deviceId}/notification`，QoS 1。通知用于提醒拉取/执行操作，完整 License、配置、用户和归属数据仍由 REST Sync 返回；不要把通知文本当作业务状态快照。

| 字段 | 类型 | 必填 | 约束/取值 | 含义 |
|---|---|---|---|---|
| `type` | `string` | 可选 | 通知动作表（第 5.3 节） | 通知类型，见动作表 |
| `priority` | `string` | 可选 | `LOW`、`NORMAL`、`HIGH` | 通知优先级 |
| `title` | `string` | 可选 | 非空 | 通知标题 |
| `message` | `string` | 可选 | 非空 | 说明文本 |
| `action` | `string` | 可选 | 非空 | 建议动作；实际按通知类型映射处理 |

示例（Topic：`bnx/device/DEV001/notification`）：

```json
{
  "meta": {
    "id": "NTF-DEV001-90001",
    "ts": "2026-10-01T08:00:00Z"
  },
  "data": {
    "type": "LICENSE_CHANGED",
    "priority": "NORMAL",
    "title": "License Updated",
    "message": "New license is available",
    "action": "SYNC"
  }
}
```

| 通知类型 | 设备动作 |
|---|---|
| `SYNC_REQUIRED` | `SYNC`：调用 /api/v1/device/sync |
| `LICENSE_CHANGED` | `SYNC`：调用 /api/v1/device/sync |
| `CONFIG_CHANGED` | `SYNC`：调用 /api/v1/device/sync |
| `USERS_CHANGED` | `SYNC`：调用 /api/v1/device/sync |
| `STATUS_CHANGED` | `SYNC`：调用 /api/v1/device/sync |
| `ASSIGNMENT_CHANGED` | `SYNC`：调用 /api/v1/device/sync |
| `CERTIFICATE_EXPIRING` | `CHECK_CERTIFICATE_STATUS`：调用证书状态 API |
| `CERTIFICATE_ROTATION_REQUIRED` | `ROTATE_CERTIFICATE`：调用证书轮换 API |
| `OTA_AVAILABLE` | `AWAIT_OTA_MESSAGE`：等待/接收 OTA Topic |
| `OTA_CANCELLED` | `CANCEL_PENDING_OTA`：取消待执行升级 |
| `SECURITY_POLICY_UPDATED` | `SYNC`：Sync 最新安全策略 |
| `DEVICE_SUSPENDED` | `ENTER_SUSPENDED_MODE`：进入 Suspended 模式 |
| `DEVICE_RETIRED` | `ENTER_RETIRED_MODE`：进入 Retired 模式 |

`DEVICE_RETIRED` 后停止业务处理和 MQTT 上报，按 REST Sync/Deactivate 的退役确认规则完成收尾；退役设备的八类业务 MQTT 上行在云端均拒绝。`DEVICE_SUSPENDED` 后停止业务处理/ESG 上报，但仍保留心跳、遥测及必要诊断、同步和维护；不能把 MQTT 可连接等同于业务可运行。

[通知目录](../../contracts/mqtt/notification-catalog.json) · [Notification Schema](../../contracts/mqtt/schemas/notification.schema.json)

## 6. 调用与自测示例

### 6.1 使用单一连接的客户端流程

```text
host = onboardingResponse.mqtt.endpoint
deviceId = onboardingResponse.deviceId
connectTLS(host, 8883, clientId=deviceId, clientCertificate, localPrivateKey, serverTrustCA)
subscribe("bnx/device/" + deviceId + "/cmd", qos=1)
subscribe("bnx/device/" + deviceId + "/ota", qos=1)
subscribe("bnx/device/" + deviceId + "/notification", qos=1)
checkSubscribeAcknowledgements()
publish("bnx/device/" + deviceId + "/heartbeat", currentHeartbeat, qos=1, retain=false)
# 云端处理首个 Heartbeat 后再执行 REST Sync；之后按返回配置调度上报
onCommand: deduplicate(meta.id), validateAndExecute(), publishCommandAck()
onOta: deduplicate(meta.id), saveTargetIdFromUrl(), downloadAndVerify(), publishOtaStageAck()
onNotification: handleByType(), syncWhenRequired()
onReconnect: restoreSubscriptions(), syncLatestState()
```

### 6.2 单次发布工具

运维已确认测试环境后，使用安装好的 MQTT 客户端执行。把合法、更新时间后的 Heartbeat 保存成 `heartbeat.json`；不要同时启动使用相同 Client ID 的固件或其他工具。

```bash
MQTT_HOST='<Onboarding返回的mqtt.endpoint>'
DEVICE_ID='<Onboarding返回的deviceId>'
mosquitto_pub -h "$MQTT_HOST" -p 8883 -V mqttv311 \
  --cafile server-trust-ca.pem --cert device-cert.pem --key device-private-key.pem \
  -i "$DEVICE_ID" -t "bnx/device/$DEVICE_ID/heartbeat" -q 1 -f heartbeat.json
```

该命令不使用 `-r`。成功发送仍需云端核对设备状态与消息处理结果。连续上报、同时订阅和重连恢复请使用固件中的同一长连接；`mosquitto_pub` 的单次调用仅用于连通性验证。

### 6.3 仓库离线检查

将报文与本页链接的 Schema 核对；仓库 MQTT 自测命令：

```bash
node --import tsx --test contracts/mqtt/*.test.ts contracts/mqtt/*.test.mjs
```

此命令验证仓库 Topic/Schema/示例及策略，不会向实际 Broker 发送消息，也不代替固件与目标环境验收。

## 7. 故障排查与联调验收

MQTT 上行没有 HTTP 状态码。Broker/TLS 错误由客户端错误回调、CONNACK/SUBACK/PUBACK 观察；业务拒绝由云端处理日志、隔离队列和数据库回执核对。以下是云端分类，并非设备会同步收到的 MQTT 错误体。

| 现象/分类 | 优先检查 |
|---|---|
| TLS/连接失败 | 测试环境、主机和 SNI、服务端信任根、客户端证书/私钥、公钥匹配、证书有效及 IoT 注册/Policy/Thing 绑定 |
| SUBACK 失败、发布拒绝或连接中断 | Client ID 是否等于原始 deviceId；Topic 方向、拼写、大小写；是否用了通配符或其他设备 Topic |
| PUBACK 成功但后台无数据 | 先查业务校验与 Customer/Site 分配，再查路由/消费/数据库；不要只依据 PUBACK 判断落库 |
| `UNKNOWN_DEVICE` / `IDENTITY_VIOLATION` | 证书台账、证书状态、Topic 设备归属、退役状态、客户分配 |
| `SCHEMA_VIOLATION` | 缺必填、类型/枚举/范围、null、未知字段，查看具体错误路径 |
| `AUDIT_HASH_MISMATCH` | 是否按最终原始 `{meta,data}` 做 JCS；是否在 Hash 后修改了 ts/seq/schemaVer/data |
| `CLOCK_SKEW` | meta.ts 格式与真实 UTC 时间；默认 ±300 秒，含过久的离线缓存 |
| `PAYLOAD_CONFLICT` | 同设备同类型复用了 seq，却改变报文；原 receipt 不会被覆盖 |
| `INVALID_REPORT` | 报告周期类型、起止时间或重叠期间 |
| `UNKNOWN_COMMAND` / `COMMAND_MISMATCH` / `INVALID_COMMAND_STATE` | 原命令 ID/名称、设备归属、发布/时效/终态；不要虚构 commandId |
| `UNKNOWN_OTA_TARGET` / `OTA_TARGET_MISMATCH` / `INVALID_OTA_STATE` | 原 target ID、设备归属、混用字段、状态迁移顺序 |
| `MEDIA_METADATA_REJECTED` / `MEDIA_SESSION_EXPIRED` | 真实上传会话、原样 objectPath、URL/会话有效期、文件存在/大小/Hash |

联调人员按下表保存测试环境、固件版本、源提交、设备 ID、Topic、消息 ID/序号、UTC 时间与云端结果。证书/私钥、下载 token 和预签名 URL 不写入共享记录。

| 检查项 | 预期结果 |
|---|---|
| 首次接入闭环 | CSR 申请 → 人工审批 → 安装证书 → 首个合法 Heartbeat → 云端 Onboarded/证书 ACTIVE；审批前不能获得设备证书 |
| 权限边界 | 自身 8 类上行可发布、3 类下行可订阅；错误 Client ID、跨设备、通配订阅、设备发布下行均拒绝 |
| 持续上报 | Heartbeat 在线状态更新；Telemetry 聚合/归档、Report 保存/归档；频率遵从 Sync 配置 |
| 告警/事件/安全 | 告警激活/解除、事件独立记录、受控安全事件及挂起行为与预期一致 |
| 正负字段/Hash/时钟 | 合法报文处理；缺必填、额外身份字段、null、错误枚举、篡改 Hash、过期时间进入隔离，后续合法消息仍处理 |
| 重复/并发/重启 | 同报文重复只写一次；同 seq 改内容隔离；重启持久序号，下行命令不重复执行 |
| 命令闭环 | 真实下行 commandId → 收到确认/最终 ACK；失败和超时按状态机处理，重复命令不重执行 |
| OTA 闭环 | 真实下载授权 → SHA-256 校验 → ACK 阶段迁移；错误目标、非法阶段、混用命令字段拒绝 |
| 媒体闭环 | 真实 REST 会话 → 文件上传 → MQTT 元数据 → 归属/大小/Hash 校验成功；非法路径/过期会话拒绝 |
| 掉线恢复 | 退避重连、恢复订阅、立即 Sync；不承诺超过时间窗的历史报文自动补传 |
| 生命周期 | Suspended 不启动业务；Retired 八类 MQTT 业务上行均拒绝，REST 退役确认按限定流程完成 |

目标 AWS 数据链路证据要求见 [BE-IOT 验收证据采集说明](../audit/evidence/BE-IOT-AWS数据链路证据采集说明.md)。真实云端接线、DNS/服务端证书、IoT 授权、数据处理和真机回执需双方留存；本地 Schema 检查不代替这些结果。

## 8. 契约来源及需要双方明确的事项

- [Topic 目录](../../contracts/mqtt/topic-catalog.json)、[消息 Tier](../../contracts/mqtt/topic-tier.json)、[下行幂等策略](../../contracts/mqtt/downlink-policy.json)、[格式与 Hash 策略](../../contracts/mqtt/payload-normalization-policy.json)、[OTA ACK 策略](../../contracts/mqtt/ota-status-channel-policy.json) 是当前可执行契约。
- 各节链接的 `schemas` 决定字段类型和范围；各节业务说明同时依据 [Ingestion 处理器](../../apps/ingestion-worker/src/ingest/dispatcher.ts)、[ACK 处理器](../../apps/ingestion-worker/src/signals/ack.ts)、[OTA 发布器](../../apps/cloud-api/src/ota/publisher.ts) 和 [单设备 Policy](../../packages/aws-clients/src/iot-device-policy.ts)。只通过 Schema 不代表满足完整业务条件。
- 原始通信设计用于理解背景，现行冻结决策和代码优先；本页仅新增对接说明，不修改协议或兼容策略。
- 联调前明确目标环境 Host/CA、Keep Alive、会话持久化/过期和离线队列策略、设备时钟来源、各传感器实际采样/单位、报告计算方法及无参数命令的执行策略。本文的客户端建议不视为服务端已冻结或已部署配置。
- Heartbeat 与 Sync 的状态值、未许可首次接入和 Maintenance 状态的映射见第 4.1 节；本页没有通过新增枚举或伪造值绕过这些现有协议边界。

本页示例设备 `DEV001`、任务 ID、对象路径和时间均为演示值。修改审计报文后必须重算 Hash；实际发送时换成当前时间、真实 ID/路径及持久序号，不得照抄静态样例到生产。
