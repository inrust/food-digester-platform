# 设备 MQTT 完整报文样例

更新日期：2026-10-18。覆盖当前 **8 类上行、3 类下行**，提供完整 JSON、命令与 OTA 回执分支、全部 22 种命令和 13 类通知。连接流程及字段约束见 [MQTT 联调说明](./iot.bio-nexa.com.md)，证书、同步、上传会话和下载授权见 [Device REST API](./device-api.bio-nexa.com.md)。

## 1. 使用方式

- [完整样例索引 JSON](./mqtt-examples/mqtt-examples.json)：55 份报文及各自的 Topic、方向、QoS 和使用说明。
- [独立 Payload 文件](./mqtt-examples/payloads/)：每个 `.json` 文件只包含一条 MQTT 业务报文，可供固件编码和离线校验参考。
- [本次离线校验结果](./mqtt-examples/validation.json)：Schema、字段覆盖、Hash 和关联检查结果。

**设备只发布上行 Topic，订阅下行 Topic。** `topic`、`qos`、`retain` 属于 MQTT 客户端参数；索引 JSON 中的 `name`、`direction`、`file` 等用于查阅，实际 Payload 只发送每条索引的 `payload` 对象或相应独立 JSON 文件内容。样例是独立场景集合，不能将所有文件按目录顺序批量发送。

| 连接参数 | 填写方式 |
|---|---|
| MQTT Host | Onboarding APPROVED 响应中的 `mqtt.endpoint` 与运维环境参数；`iot.bio-nexa.com:8883` 已于 2026-10-22 连接实测通过 |
| 端口与认证 | TLS 8883，设备 X.509 证书及本地私钥 |
| TLS SNI | 与 MQTT Host 完全一致，并验证服务端证书链及主机名 |
| Client ID | 原样使用实际 `deviceId` |
| QoS 与 Retain | 全部业务 Topic 使用 QoS 1、Retain false |

## 2. 发送前替换演示值

示例统一使用设备 `DEV001`、2026-10-18 的 UTC 时间以及虚构用户、客户、任务和上传会话。**实际发送前必须替换为真实值**：

1. Topic 与 Client ID 使用 Onboarding 返回的原始 deviceId。设备身份和客户归属由证书、Topic 与台账确定，不在 Payload 增加 deviceId、customerId、tenantId、siteId 或云端 iot* 信封字段。
2. meta.id 全局唯一，使用大写字母、数字、连字符，最长 128 字符；meta.ts 为当前 UTC 时间，默认与 Broker 接收时间偏差不得超过 300 秒。
3. 上行 meta.seq 必填，同设备同 Topic 类型持久递增，重启不能归零复用；命令与 OTA 共用 ack 序号空间。下行 seq 可省略，不应依赖其存在。
4. QoS 重发保留同一消息的 id、ts、seq、data 和 audit.hash；同 seq 不同内容会触发冲突。新的消息使用新 ID 与递增 seq。
5. 数字与布尔值保持 JSON 原生类型，缺测可选字段省略，不能用 0 或空串代替。除 ack.data.errorCode 明确允许 null 外，其他列出的可选字段不要发送 null。
6. COMMAND 回执中的真实 commandId、OTA 的真实 otaTargetId、上传会话返回的 objectPath 以及有效下载授权不能照抄样例。云端 PUBACK 只证明 Broker 收到，不证明业务落库。

## 3. Topic 总览

所有 Topic 均以 `bnx/device/{deviceId}/` 为前缀，大小写与实际 deviceId 一致。

| 类型 | 设备动作 | 完整样例 |
|---|---|---|
| `heartbeat` | 发布 | [heartbeat](./mqtt-examples/payloads/01-heartbeat.json) |
| `telemetry` | 发布 | [telemetry](./mqtt-examples/payloads/02-telemetry.json) |
| `report` | 发布 | [report](./mqtt-examples/payloads/03-report.json) |
| `alarm` | 发布 | [alarm](./mqtt-examples/payloads/04-alarm.json) |
| `event` | 发布 | [event](./mqtt-examples/payloads/05-event.json) |
| `tamper` | 发布 | [tamper](./mqtt-examples/payloads/06-tamper.json) |
| `ack` | 发布 | [ack-command-success](./mqtt-examples/payloads/07-ack-command-success.json) |
| `ack` | 发布 | [ack-ota-downloading](./mqtt-examples/payloads/08-ack-ota-downloading.json) |
| `media` | 发布 | [media](./mqtt-examples/payloads/09-media.json) |
| `cmd` | 订阅接收 | [cmd](./mqtt-examples/payloads/10-cmd.json) |
| `ota` | 订阅接收 | [ota](./mqtt-examples/payloads/11-ota.json) |
| `notification` | 订阅接收 | [notification](./mqtt-examples/payloads/12-notification.json) |

## 4. 八类上行与三类下行完整报文

以下报文填入该场景适用的全部 data 字段，便于逐项对照；可选字段不代表每次都必须发送。ACK 的 COMMAND 与 OTA_TARGET 字段互斥，因此分开列出。

### 4.1 heartbeat

Topic：`bnx/device/DEV001/heartbeat`；方向：设备 → 云端；QoS 1；Retain false。

示例表示设备及 License 均已 Active。Heartbeat 使用扁平字段；不能将 REST Sync 的 Maintenance 或 NO_LICENSE 原样填入。未许可首次接入的状态映射仍需双方明确，不得伪报 ACTIVE。

```json
{
  "meta": {
    "id": "HB-DEV001-100",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 100,
    "schemaVer": "1.0"
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

[独立 JSON](./mqtt-examples/payloads/01-heartbeat.json) · [字段 Schema](../../contracts/mqtt/schemas/heartbeat.schema.json)

### 4.2 telemetry

Topic：`bnx/device/DEV001/telemetry`；方向：设备 → 云端；QoS 1；Retain false。

示例列出全部 13 项指标。实际缺测字段省略；powerConsumptionKw 是功率 kW，currentAmp 是电流 A。

```json
{
  "meta": {
    "id": "TEL-DEV001-10001",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 10001,
    "schemaVer": "1.0"
  },
  "audit": {
    "hash": "1e70de4a3554075016bde187ce5ad3c18563bd1d57f9875945f0af6ccde2c068"
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

[独立 JSON](./mqtt-examples/payloads/02-telemetry.json) · [字段 Schema](../../contracts/mqtt/schemas/telemetry.schema.json)

### 4.3 report

Topic：`bnx/device/DEV001/report`；方向：设备 → 云端；QoS 1；Retain false。

业务必须提供 reportType、periodStartTime、periodEndTime；同设备同类型统计期间不得重叠。energyConsumptionKwh 为累计电能 kWh；DEFAULT_V1 和减碳数值仅演示字段格式。

```json
{
  "meta": {
    "id": "RPT-DEV001-20001",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 20001,
    "schemaVer": "1.0"
  },
  "audit": {
    "hash": "89bcab306f94ff0dbbf5be8c7fb5e2020ef06b1edf1d2c234bb90eb4bbd13410"
  },
  "data": {
    "reportType": "DAILY",
    "periodStartTime": "2026-10-17T00:00:00Z",
    "periodEndTime": "2026-10-17T23:59:59Z",
    "feedingWeightKg": 250,
    "dischargeWeightKg": 180,
    "reductionWeightKg": 70,
    "cycleCount": 12,
    "processingDurationMinutes": 480,
    "energyConsumptionKwh": 19.2,
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

[独立 JSON](./mqtt-examples/payloads/03-report.json) · [字段 Schema](../../contracts/mqtt/schemas/report.schema.json)

### 4.4 alarm

Topic：`bnx/device/DEV001/alarm`；方向：设备 → 云端；QoS 1；Retain false。

code 与 status 为业务必填。解除告警时使用相同 code、CLEARED、新消息 ID 与新 seq；解除样例见后文。

```json
{
  "meta": {
    "id": "ALM-DEV001-30001",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 30001,
    "schemaVer": "1.0"
  },
  "data": {
    "code": "TEMP_HIGH",
    "category": "TEMPERATURE",
    "severity": "HIGH",
    "status": "ACTIVE",
    "detectedTime": "2026-10-18T08:00:00Z",
    "component": "HEATER",
    "currentValue": 88,
    "threshold": 80,
    "unit": "C",
    "message": "Heating temperature exceeded threshold",
    "recommendedAction": "CHECK_HEATER"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/04-alarm.json) · [字段 Schema](../../contracts/mqtt/schemas/alarm.schema.json)

### 4.5 event

Topic：`bnx/device/DEV001/event`；方向：设备 → 云端；QoS 1；Retain false。

操作者 userId 与 username 表示业务用户，不替代设备证书身份。

```json
{
  "meta": {
    "id": "EVT-DEV001-40001",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 40001,
    "schemaVer": "1.0"
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

[独立 JSON](./mqtt-examples/payloads/05-event.json) · [字段 Schema](../../contracts/mqtt/schemas/event.schema.json)

### 4.6 tamper

Topic：`bnx/device/DEV001/tamper`；方向：设备 → 云端；QoS 1；Retain false。

这里使用 WARNING 安全事件。CRITICAL 可能触发设备自动挂起；不要在生产设备上随意发送。

```json
{
  "meta": {
    "id": "TMP-DEV001-60001",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 60001,
    "schemaVer": "1.0"
  },
  "audit": {
    "hash": "91acac5b929860e7978f3c037f0cf2b2264af76d706346a20252d8b62d9c4f58"
  },
  "data": {
    "eventType": "ENCLOSURE_OPENED",
    "severity": "WARNING",
    "component": "ENCLOSURE",
    "details": "Enclosure opened during maintenance inspection",
    "actionTaken": "EVENT_RECORDED"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/06-tamper.json) · [字段 Schema](../../contracts/mqtt/schemas/tamper.schema.json)

### 4.7 ack-command-success

Topic：`bnx/device/DEV001/ack`；方向：设备 → 云端；QoS 1；Retain false。

commandId 逐字符回传原始 cmd.meta.id，command 与原命令一致。SUCCESS 是命令最终成功结果；仅收到确认时省略 result，见后文。

```json
{
  "meta": {
    "id": "ACK-DEV001-50001",
    "ts": "2026-10-18T08:00:00.623Z",
    "seq": 50001,
    "schemaVer": "1.0"
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

[独立 JSON](./mqtt-examples/payloads/07-ack-command-success.json) · [字段 Schema](../../contracts/mqtt/schemas/ack.schema.json)

### 4.8 ack-ota-downloading

Topic：`bnx/device/DEV001/ack`；方向：设备 → 云端；QoS 1；Retain false。

otaTargetId 从原始下载 URL 的 targets/{targetId}/download 路径段提取并 URL 解码。不能截取大写 ota.meta.id 代替原始 ID；OTA 回执禁止混入 commandId、command、result、executeTimeMs。

```json
{
  "meta": {
    "id": "ACK-DEV001-50002",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 50002,
    "schemaVer": "1.0"
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

[独立 JSON](./mqtt-examples/payloads/08-ack-ota-downloading.json) · [字段 Schema](../../contracts/mqtt/schemas/ack.schema.json)

### 4.9 media

Topic：`bnx/device/DEV001/media`；方向：设备 → 云端；QoS 1；Retain false。

先通过 Device REST 创建上传会话、按要求上传文件，再发布元数据。objectPath 须原样使用真实会话值，sizeKb = ceil(bytes / 1024)。示例文件路径不可直接用于联调，不通过 MQTT 发送文件二进制或 Base64。

```json
{
  "meta": {
    "id": "MED-DEV001-70001",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 70001,
    "schemaVer": "1.0"
  },
  "data": {
    "mediaType": "IMAGE",
    "captureTime": "2026-10-18T07:59:55Z",
    "fileName": "capture-001.jpg",
    "objectPath": "media/CUS001/DEV001/MEDSES001/capture-001.jpg",
    "sizeKb": 120,
    "durationSec": 0
  }
}
```

[独立 JSON](./mqtt-examples/payloads/09-media.json) · [字段 Schema](../../contracts/mqtt/schemas/media.schema.json)

### 4.10 cmd

Topic：`bnx/device/DEV001/cmd`；方向：云端 → 设备；QoS 1；Retain false。

meta.id 就是 commandId。先校验 requestTime + timeoutSec、本地状态及安全条件；重复 meta.id 不重复执行。当前无 parameters 或温度目标字段，SET_TARGET_TEMPERATURE 也不能自行添加参数。

```json
{
  "meta": {
    "id": "CMD-DEV001-6001",
    "ts": "2026-10-18T08:00:00Z"
  },
  "data": {
    "command": "START",
    "requestedBy": "tenant_admin",
    "requestTime": "2026-10-18T08:00:00Z",
    "timeoutSec": 30,
    "remarks": "Start processing batch"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/10-cmd.json) · [字段 Schema](../../contracts/mqtt/schemas/cmd.schema.json)

### 4.11 ota

Topic：`bnx/device/DEV001/ota`；方向：云端 → 设备；QoS 1；Retain false。

downloadUrl 中的 token 和 sha256 为演示值；真实下载需设备 mTLS，获得 307 Location 后下载并核验包摘要。原始 targetId 为 OTATGT001，meta.id 由其大写形式派生。

```json
{
  "meta": {
    "id": "OTA-OTATGT001",
    "ts": "2026-10-18T08:00:00Z"
  },
  "data": {
    "version": "2.1.0",
    "packageType": "FIRMWARE",
    "downloadUrl": "https://device-api.bio-nexa.com/api/v1/device/ota/targets/OTATGT001/download?token=example-download-grant-for-test-only",
    "sha256": "ABC123DEF4567890ABC123DEF4567890ABC123DEF4567890ABC123DEF4567890",
    "mandatory": false,
    "scheduledTime": "2026-10-18T08:00:00Z"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/11-ota.json) · [字段 Schema](../../contracts/mqtt/schemas/ota.schema.json)

### 4.12 notification

Topic：`bnx/device/DEV001/notification`；方向：云端 → 设备；QoS 1；Retain false。

通知用于提醒动作；完整归属、License、配置与用户信息仍通过 REST Sync 获取。其余 12 类通知与动作见后文。

```json
{
  "meta": {
    "id": "NTF-DEV001-90001",
    "ts": "2026-10-18T08:00:00Z"
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

[独立 JSON](./mqtt-examples/payloads/12-notification.json) · [字段 Schema](../../contracts/mqtt/schemas/notification.schema.json)

## 5. 回执与异常分支

命令正常路径为接收确认 → SUCCESS；FAILED 与 SUCCESS 为替代结果，不能对同一任务连续报告两个最终执行结果。接收确认省略 result，最终回执必须使用新序号。

OTA 正常路径：NOTIFIED（云端状态）→ DOWNLOADING → INSTALLING → SUCCEEDED。NOTIFIED 不作为设备回执；没有 DOWNLOADED 状态，也不新建 ota/status Topic。FAILED 可从 NOTIFIED、DOWNLOADING 或 INSTALLING 进入，进入后不可继续安装；ROLLED_BACK 仅从 INSTALLING 或 SUCCEEDED 进入。下列失败和回滚样例独立演示，请按真实前置状态选择。

### 5.1 ack-command-received

Topic：`bnx/device/DEV001/ack`；设备 → 云端；QoS 1；Retain false。

先收到确认，再使用新 seq 报告最终结果；本报文省略 result。

```json
{
  "meta": {
    "id": "ACK-DEV001-50000",
    "ts": "2026-10-18T08:00:00.100Z",
    "seq": 50000,
    "schemaVer": "1.0"
  },
  "data": {
    "objectType": "COMMAND",
    "commandId": "CMD-DEV001-6001",
    "command": "START",
    "message": "Command received"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/13-ack-command-received.json)

### 5.2 ack-command-failed-alternative

Topic：`bnx/device/DEV001/ack`；设备 → 云端；QoS 1；Retain false。

与 command-success 二选一；错误代码为示例文本，并非冻结错误码目录。

```json
{
  "meta": {
    "id": "ACK-DEV001-50007",
    "ts": "2026-10-18T08:00:01Z",
    "seq": 50007,
    "schemaVer": "1.0"
  },
  "data": {
    "objectType": "COMMAND",
    "commandId": "CMD-DEV001-6001",
    "command": "START",
    "result": "FAILED",
    "executeTimeMs": 523,
    "errorCode": "LOCAL_SAFETY_INTERLOCK",
    "message": "Safety interlock prevents machine start"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/14-ack-command-failed-alternative.json)

### 5.3 ack-ota-installing

Topic：`bnx/device/DEV001/ack`；设备 → 云端；QoS 1；Retain false。

OTA 正常流程阶段。

```json
{
  "meta": {
    "id": "ACK-DEV001-50003",
    "ts": "2026-10-18T08:01:00Z",
    "seq": 50003,
    "schemaVer": "1.0"
  },
  "data": {
    "objectType": "OTA_TARGET",
    "otaTargetId": "OTATGT001",
    "status": "INSTALLING",
    "errorCode": null,
    "message": "OTA installing"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/15-ack-ota-installing.json)

### 5.4 ack-ota-succeeded

Topic：`bnx/device/DEV001/ack`；设备 → 云端；QoS 1；Retain false。

OTA 正常流程阶段。

```json
{
  "meta": {
    "id": "ACK-DEV001-50004",
    "ts": "2026-10-18T08:03:00Z",
    "seq": 50004,
    "schemaVer": "1.0"
  },
  "data": {
    "objectType": "OTA_TARGET",
    "otaTargetId": "OTATGT001",
    "status": "SUCCEEDED",
    "errorCode": null,
    "message": "OTA succeeded"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/16-ack-ota-succeeded.json)

### 5.5 ack-ota-failed

Topic：`bnx/device/DEV001/ack`；设备 → 云端；QoS 1；Retain false。

下载校验失败的替代分支；从 NOTIFIED 或 DOWNLOADING 可进入 FAILED，失败后不能继续 INSTALLING。

```json
{
  "meta": {
    "id": "ACK-DEV001-50005",
    "ts": "2026-10-18T08:00:30Z",
    "seq": 50005,
    "schemaVer": "1.0"
  },
  "data": {
    "objectType": "OTA_TARGET",
    "otaTargetId": "OTATGT001",
    "status": "FAILED",
    "errorCode": "PACKAGE_HASH_MISMATCH",
    "message": "OTA failed"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/17-ack-ota-failed.json)

### 5.6 ack-ota-rolled_back

Topic：`bnx/device/DEV001/ack`；设备 → 云端；QoS 1；Retain false。

异常分支独立演示；不要将目录中全部回执按文件顺序依次发送。

```json
{
  "meta": {
    "id": "ACK-DEV001-50006",
    "ts": "2026-10-18T08:04:00Z",
    "seq": 50006,
    "schemaVer": "1.0"
  },
  "data": {
    "objectType": "OTA_TARGET",
    "otaTargetId": "OTATGT001",
    "status": "ROLLED_BACK",
    "errorCode": null,
    "message": "OTA rolled_back"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/18-ack-ota-rolled_back.json)

### 5.7 alarm-cleared

Topic：`bnx/device/DEV001/alarm`；设备 → 云端；QoS 1；Retain false。

与 ACTIVE 告警使用同一 code，使用新消息 ID 和 seq。

```json
{
  "meta": {
    "id": "ALM-DEV001-30002",
    "ts": "2026-10-18T08:02:00Z",
    "seq": 30002,
    "schemaVer": "1.0"
  },
  "data": {
    "code": "TEMP_HIGH",
    "category": "TEMPERATURE",
    "severity": "INFO",
    "status": "CLEARED",
    "detectedTime": "2026-10-18T08:02:00Z",
    "component": "HEATER",
    "currentValue": 72,
    "threshold": 80,
    "unit": "C",
    "message": "Heating temperature returned to normal",
    "recommendedAction": "RESUME_MONITORING"
  }
}
```

[独立 JSON](./mqtt-examples/payloads/19-alarm-cleared.json)

### 5.8 media-video

Topic：`bnx/device/DEV001/media`；设备 → 云端；QoS 1；Retain false。

文件及路径仅演示；真实发送前先取得上传会话并完成文件上传。

```json
{
  "meta": {
    "id": "MED-DEV001-70002",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 70002,
    "schemaVer": "1.0"
  },
  "data": {
    "mediaType": "VIDEO",
    "captureTime": "2026-10-18T07:59:55Z",
    "fileName": "capture-002.mp4",
    "objectPath": "media/CUS001/DEV001/MEDSES002/capture-002.mp4",
    "sizeKb": 2048,
    "durationSec": 10
  }
}
```

[独立 JSON](./mqtt-examples/payloads/20-media-video.json)

### 5.9 report-hourly

Topic：`bnx/device/DEV001/report`；设备 → 云端；QoS 1；Retain false。

报告为独立周期类型样例，字段含义同上。

```json
{
  "meta": {
    "id": "RPT-DEV001-20002",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 20002,
    "schemaVer": "1.0"
  },
  "audit": {
    "hash": "7ab6aa3a2ea08589eb4a40afb7e40ce245b0a0fb08f355f25254403c245058d4"
  },
  "data": {
    "reportType": "HOURLY",
    "periodStartTime": "2026-10-18T07:00:00Z",
    "periodEndTime": "2026-10-18T08:00:00Z",
    "feedingWeightKg": 25,
    "dischargeWeightKg": 18,
    "reductionWeightKg": 7,
    "cycleCount": 1,
    "processingDurationMinutes": 60,
    "energyConsumptionKwh": 2.4,
    "averagePowerKw": 2.4,
    "averageO2Pct": 20.4,
    "averageCo2Ppm": 430,
    "averageCh4Ppm": 11,
    "averageN2oPpm": 1.4,
    "carbonReductionKg": 3.56,
    "carbonReductionMethod": "DEFAULT_V1",
    "dataCompletenessPct": 100,
    "missingRecordCount": 0
  }
}
```

[独立 JSON](./mqtt-examples/payloads/21-report-hourly.json)

### 5.10 report-cycle

Topic：`bnx/device/DEV001/report`；设备 → 云端；QoS 1；Retain false。

报告为独立周期类型样例，字段含义同上。

```json
{
  "meta": {
    "id": "RPT-DEV001-20003",
    "ts": "2026-10-18T08:00:00Z",
    "seq": 20003,
    "schemaVer": "1.0"
  },
  "audit": {
    "hash": "59206817ef03f774837ac38638281fd1b29af0462488c4b952dab998356a48e3"
  },
  "data": {
    "reportType": "CYCLE",
    "periodStartTime": "2026-10-18T07:00:00Z",
    "periodEndTime": "2026-10-18T08:00:00Z",
    "feedingWeightKg": 25,
    "dischargeWeightKg": 18,
    "reductionWeightKg": 7,
    "cycleCount": 1,
    "processingDurationMinutes": 60,
    "energyConsumptionKwh": 2.4,
    "averagePowerKw": 2.4,
    "averageO2Pct": 20.4,
    "averageCo2Ppm": 430,
    "averageCh4Ppm": 11,
    "averageN2oPpm": 1.4,
    "carbonReductionKg": 3.56,
    "carbonReductionMethod": "DEFAULT_V1",
    "dataCompletenessPct": 100,
    "missingRecordCount": 0
  }
}
```

[独立 JSON](./mqtt-examples/payloads/22-report-cycle.json)

## 6. 全部命令与通知样例

每一项均链接到完整 JSON。命令是云端下发格式，设备不能向 cmd Topic 发布；下发与执行仍需满足云端权限、License、型号约束和设备安全条件。

### 6.1 二十二种命令

| 命令 | 完整 JSON |
|---|---|
| `START` | [查看样例](./mqtt-examples/payloads/10-cmd.json) |
| `STOP` | [查看样例](./mqtt-examples/payloads/23-cmd-stop.json) |
| `PAUSE` | [查看样例](./mqtt-examples/payloads/24-cmd-pause.json) |
| `RESUME` | [查看样例](./mqtt-examples/payloads/25-cmd-resume.json) |
| `EMERGENCY_STOP` | [查看样例](./mqtt-examples/payloads/26-cmd-emergency_stop.json) |
| `AGITATOR_FORWARD` | [查看样例](./mqtt-examples/payloads/27-cmd-agitator_forward.json) |
| `AGITATOR_REVERSE` | [查看样例](./mqtt-examples/payloads/28-cmd-agitator_reverse.json) |
| `AGITATOR_STOP` | [查看样例](./mqtt-examples/payloads/29-cmd-agitator_stop.json) |
| `HEATING_ON` | [查看样例](./mqtt-examples/payloads/30-cmd-heating_on.json) |
| `HEATING_OFF` | [查看样例](./mqtt-examples/payloads/31-cmd-heating_off.json) |
| `SET_TARGET_TEMPERATURE` | [查看样例](./mqtt-examples/payloads/32-cmd-set_target_temperature.json) |
| `EXHAUST_ON` | [查看样例](./mqtt-examples/payloads/33-cmd-exhaust_on.json) |
| `EXHAUST_OFF` | [查看样例](./mqtt-examples/payloads/34-cmd-exhaust_off.json) |
| `AIR_SUPPLY_ON` | [查看样例](./mqtt-examples/payloads/35-cmd-air_supply_on.json) |
| `AIR_SUPPLY_OFF` | [查看样例](./mqtt-examples/payloads/36-cmd-air_supply_off.json) |
| `DISCHARGE_START` | [查看样例](./mqtt-examples/payloads/37-cmd-discharge_start.json) |
| `DISCHARGE_STOP` | [查看样例](./mqtt-examples/payloads/38-cmd-discharge_stop.json) |
| `REBOOT` | [查看样例](./mqtt-examples/payloads/39-cmd-reboot.json) |
| `SHUTDOWN` | [查看样例](./mqtt-examples/payloads/40-cmd-shutdown.json) |
| `FACTORY_RESET` | [查看样例](./mqtt-examples/payloads/41-cmd-factory_reset.json) |
| `TAKE_SNAPSHOT` | [查看样例](./mqtt-examples/payloads/42-cmd-take_snapshot.json) |
| `FORCE_SYNC` | [查看样例](./mqtt-examples/payloads/43-cmd-force_sync.json) |

### 6.2 十三类通知

| 通知类型 | 设备动作 | 完整 JSON |
|---|---|---|
| `SYNC_REQUIRED` | `SYNC` | [查看样例](./mqtt-examples/payloads/44-notification-sync_required.json) |
| `LICENSE_CHANGED` | `SYNC` | [查看样例](./mqtt-examples/payloads/12-notification.json) |
| `CONFIG_CHANGED` | `SYNC` | [查看样例](./mqtt-examples/payloads/45-notification-config_changed.json) |
| `USERS_CHANGED` | `SYNC` | [查看样例](./mqtt-examples/payloads/46-notification-users_changed.json) |
| `STATUS_CHANGED` | `SYNC` | [查看样例](./mqtt-examples/payloads/47-notification-status_changed.json) |
| `ASSIGNMENT_CHANGED` | `SYNC` | [查看样例](./mqtt-examples/payloads/48-notification-assignment_changed.json) |
| `CERTIFICATE_EXPIRING` | `CHECK_CERTIFICATE_STATUS` | [查看样例](./mqtt-examples/payloads/49-notification-certificate_expiring.json) |
| `CERTIFICATE_ROTATION_REQUIRED` | `ROTATE_CERTIFICATE` | [查看样例](./mqtt-examples/payloads/50-notification-certificate_rotation_required.json) |
| `OTA_AVAILABLE` | `AWAIT_OTA_MESSAGE` | [查看样例](./mqtt-examples/payloads/51-notification-ota_available.json) |
| `OTA_CANCELLED` | `CANCEL_PENDING_OTA` | [查看样例](./mqtt-examples/payloads/52-notification-ota_cancelled.json) |
| `SECURITY_POLICY_UPDATED` | `SYNC` | [查看样例](./mqtt-examples/payloads/53-notification-security_policy_updated.json) |
| `DEVICE_SUSPENDED` | `ENTER_SUSPENDED_MODE` | [查看样例](./mqtt-examples/payloads/54-notification-device_suspended.json) |
| `DEVICE_RETIRED` | `ENTER_RETIRED_MODE` | [查看样例](./mqtt-examples/payloads/55-notification-device_retired.json) |

## 7. 审计 Hash 与校验

只有 telemetry、report、tamper 必须携带 audit.hash，其他八类 Topic 不携带 audit。计算对象仅为原始 `{meta,data}`：

```text
canonical = RFC8785_JCS({meta: payload.meta, data: payload.data})
audit.hash = SHA256(UTF8(canonical)).lowercaseHex()
```

变更 meta.id、meta.ts、meta.seq、meta.schemaVer 或 data 后必须重新计算 Hash。展示缩进和对象成员顺序不影响结果；不能使用普通带缩进 JSON 字符串代替 JCS，也不能将 audit 本身参与计算。

以下向量与对应 JSON 精确配套：

| 样例 | canonical 字符串 | SHA-256 |
|---|---|---|
| telemetry | [UTF-8 JCS 向量](./mqtt-examples/payloads/02-telemetry.canonical.txt) | `1e70de4a3554075016bde187ce5ad3c18563bd1d57f9875945f0af6ccde2c068` |
| report | [UTF-8 JCS 向量](./mqtt-examples/payloads/03-report.canonical.txt) | `89bcab306f94ff0dbbf5be8c7fb5e2020ef06b1edf1d2c234bb90eb4bbd13410` |
| tamper | [UTF-8 JCS 向量](./mqtt-examples/payloads/06-tamper.canonical.txt) | `91acac5b929860e7978f3c037f0cf2b2264af76d706346a20252d8b62d9c4f58` |
| report-hourly | [UTF-8 JCS 向量](./mqtt-examples/payloads/21-report-hourly.canonical.txt) | `7ab6aa3a2ea08589eb4a40afb7e40ce245b0a0fb08f355f25254403c245058d4` |
| report-cycle | [UTF-8 JCS 向量](./mqtt-examples/payloads/22-report-cycle.canonical.txt) | `59206817ef03f774837ac38638281fd1b29af0462488c4b952dab998356a48e3` |

`.canonical.txt` 文件末尾为便于文本阅读添加了一个换行；计算 Hash 时只取该行 JSON 的 UTF-8 字节，不包含末尾换行。

55 份报文已通过仓库 Schema 校验，11 类 Topic 的 data 字段已全部覆盖，5 个审计 Hash 已核验。ACK 序号不重复，命令与 OTA 关联 ID 已检查；这些属于离线样例校验。另有 [2026-10-22 MQTT 自定义域名实测](../audit/2026-10-22-mqtt-custom-domain-live-test.md) 验证 TLS、临时 X.509 身份连接、三个下行订阅许可和保活；后续 [业务实测报告](../audit/2026-10-22-mqtt-business-live-test.md) 记录了独立软件设备的 8 类上行、3 类下行与云端处理核对。该实测没有逐一发送这里的全部 55 份样例，也不证明真实固件执行命令或 OTA 下载安装。另见 [真实 CSR 与双通道轮换实测](../audit/2026-10-22-csr-lifecycle-live-test.md)：已验证软件隔离设备的申请/审批、项目 CA 发证、首 Heartbeat 激活、未分配设备的 REST Sync 和两种顺序的轮换确认；上一轮 [完整 REST Sync 实测](../audit/2026-10-22-rest-sync-live-test.md) 保留运行状态枚举大小写的契约失败；后续 [状态修复、部署及隔离复测](../audit/2026-10-22-rest-sync-status-fix-live-test.md) 已通过 161/161 项检查，15 次成功 Sync 的 Schema 与九次完整业务快照核对均通过。新 Heartbeat 写入及历史读取均映射为 REST Active，MQTT 枚举不变，测试资源已清理。真实固件、独立 License 验签与 VERIFIED → Active、本地应用仍需设备方联调。

契约来源：[Topic 目录](../../contracts/mqtt/topic-catalog.json)、[命令目录](../../contracts/mqtt/command-catalog.json)、[通知目录](../../contracts/mqtt/notification-catalog.json)、[OTA ACK 状态策略](../../contracts/mqtt/ota-status-channel-policy.json)、[Hash 实现](../../contracts/mqtt/payload-normalization.ts)。

[独立 License HMAC 与业务激活前置核验](../audit/2026-10-22-license-hmac-activation-preflight.md)确认运营尚未提供获权通道，目标独立验签及 `VERIFIED → Active` 为 **BLOCKED / NOT_RUN**。本轮没有发送本样例中的报文或创建云资源；样例字段与本地工具测试不能作为设备业务激活证明。
