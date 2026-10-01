# `onboard-api.bio-nexa.com` API

Base URL：`https://onboard-api.bio-nexa.com`。本文以 [可执行 OpenAPI](../../contracts/rest/device-onboarding-api.json) 为准，描述设备只有印刷序列号、没有预置 Token 时的首次接入流程。设备无需取得、预置或写入平台 Token。

审批后连接返回的 MQTT endpoint、发布首个 Heartbeat 及后续数据上报，见 [设备 MQTT 联调说明](./iot.bio-nexa.com.md)。

## 联调前提与职责

设备方负责在设备本地生成并持久保存 **RSA 2048 位或更强的私钥**，生成 PKCS#10 PEM CSR，且私钥始终留在设备；设备还须能使用该私钥作 RSA-SHA256 签名、保存 `requestId` 和安装返回的证书。设备库存须预先有印刷序列号，处于 `PendingOnboarding`。管理员按照双方认可的线下管理制度核对实物、安装记录、申请时间和 CSR 公钥指纹后审批；**序列号与 CSR 本身不证明实物身份**。

审批通过后，云端对已申请的 CSR 公钥签发证书并注册 AWS IoT Core。新流程下发 `certificatePem` 与 `certificateChain`，云端不生成或返回设备私钥。设备用证书连接 IoT Core、发送首个合法 Heartbeat 后才完成接入；审批通过不等于接入完成。证书包 24 小时有效，超时按既有撤证及 `REJECTED/ONBOARDING_TIMEOUT` 规则收敛。目标 AWS 与真实设备联调：**NOT RUN / NO RECEIPT**。

## `POST /api/v1/device/onboarding/request`

无需 `Authorization` 请求头。请求体为 JSON，未知字段拒绝；CSR 上限 8192 字符，必须是签名有效且 RSA 公钥至少 2048 位的 PEM PKCS#10 请求；CSR 签名仅允许 RSA-SHA256/384/512。Subject 属性不得包含控制字符，单项不超过 128 字符。跨设备复用公钥返回 `409 CONFLICT`，同一设备的申请重试允许复用该申请公钥。最终证书 CN 与 URI SAN 由服务器按库存 `deviceId` 设置，不复制 CSR 自报身份。

```http
POST /api/v1/device/onboarding/request HTTP/1.1
Host: onboard-api.bio-nexa.com
Content-Type: application/json
```

```json
{
  "serialNumber": "BNX202600001",
  "model": "BNX-100",
  "hardwareVersion": "1.0",
  "manufacturer": "Bio-Nexa",
  "manufactureDate": "2026-07-01",
  "csrPem": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----"
}
```

成功新建返回 `201`，同一序列号及相同公钥的 `PENDING` 重试返回 `200`：

```json
{ "requestId": "9cb7774e-9f10-48df-8d01-364c24023bc5", "status": "PENDING" }
```

同序列号已有**不同公钥**的待审核申请返回 `409 CONFLICT`，不得静默替换旧申请。库存不存在返回 `404 NOT_FOUND`，设备状态不允许返回 `409 DEVICE_STATE_NOT_ALLOWED`；字段或 CSR 无效返回 `400 VALIDATION_FAILED`；限流返回 `429 RATE_LIMITED`。管理员需拒绝可疑申请，不能仅凭正确序列号审批。

## `GET /api/v1/device/onboarding/status`

设备使用上述 `requestId` 定位申请，用申请 CSR 对应的本地私钥签名每次轮询。`requestId` 只是定位符，不是凭据。建议约每 30 秒轮询，`429` 时退避。

```http
GET /api/v1/device/onboarding/status?requestId=9cb7774e-9f10-48df-8d01-364c24023bc5 HTTP/1.1
Host: onboard-api.bio-nexa.com
X-Onboarding-Timestamp: 1780000000000
X-Onboarding-Nonce: <本次新生成的至少16字节随机数的base64url编码>
X-Onboarding-Signature: <Base64编码的RSA-SHA256签名>
```

签名原文为 UTF-8 字节，**不带末尾换行**，字段间为单个 LF（`\n`）：

```text
GET
/api/v1/device/onboarding/status
<requestId>
<Unix毫秒时间戳>
<nonce>
```

使用 RSA PKCS#1 v1.5 + SHA-256 签名，签名结果采用标准 Base64（非 URL 编码）。时间戳与服务端偏差须在 300 秒内；每次使用新随机数，已使用随机数的重放返回 `401 UNAUTHENTICATED`。客户端应有可靠时钟；设备时钟未同步时需先完成时间同步。此签名只证明轮询者持有申请时的私钥，不能替代线下实物核验。

响应仅有以下三类：

```json
{ "status": "PENDING" }
```

```json
{ "status": "REJECTED", "reason": "REJECTED" }
```

```json
{
  "status": "APPROVED",
  "deviceId": "device-id",
  "certificate": {
    "certificatePem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "certificateChain": "-----BEGIN CERTIFICATE-----\n<issuing CA>\n-----END CERTIFICATE-----\n<remaining CA chain>"
  },
  "mqtt": { "endpoint": "example-ats.iot.ap-southeast-1.amazonaws.com" },
  "rest": { "endpoint": "https://device-api.bio-nexa.com" },
  "configuration": { "heartbeatInterval": 60 }
}
```

审批已通过但发证尚未完成时仍返回 `PENDING`。设备安装前必须核对证书公钥与本地私钥匹配。证书一次性领取；响应提交后服务端销毁待领包。丢包或未确认领取按既有撤证重签恢复，设备继续以新随机数签名轮询。`REJECTED` 的 `reason` 可为管理员原因或 `ONBOARDING_TIMEOUT`。

统一错误体为 `{ "error": { "code": "...", "message": "...", "requestId": "<网关请求ID>" } }`。状态接口签名错误、过期、重放或申请不可定位统一返回 `401 UNAUTHENTICATED`；限流返回 `429 RATE_LIMITED`。

首次接入接口不接受 `Authorization: Bearer`；申请时携带该请求头返回 `400 VALIDATION_FAILED`，状态轮询携带该请求头返回 `401 UNAUTHENTICATED`。

## 同一证书用于 MQTT 和 REST

`certificatePem` 是项目 CA 签发的叶证书，包含 `digitalSignature`、`clientAuth`、CN=`deviceId` 和 URI SAN=`urn:fdp:device:<deviceId>`。`certificateChain` 是 PEM 字符串，按签发 CA → 上级 CA → 自签根 CA 顺序排列，不包含叶证书。设备安装叶证书、客户端 CA chain 和原本地私钥；同一张叶证书用于 AWS IoT MQTT 和 Device REST mTLS。

AWS IoT 使用 `RegisterCertificateWithoutCA` 注册该叶证书，设备必须向实际 MQTT Host 发送 TLS SNI。此路径不要求在 AWS IoT 注册项目 CA；REST Truststore 必须信任项目 CA。客户端 CA chain 不能代替用于验证 MQTT/REST 服务端主机名和服务端证书的信任根。

首次领取后先用新证书发送合法 Heartbeat，按 DEC-017 完成 Onboarding；随后向 `rest.endpoint` 调用 `POST /api/v1/device/sync`。平台分别记录 `mqttVerifiedAt` 与 `restVerifiedAt`，首次接入不等待 REST 验证才激活。轮换的双通道确认要求见 [Device API](./device-api.bio-nexa.com.md)。
