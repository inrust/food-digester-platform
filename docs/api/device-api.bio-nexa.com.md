# `device-api.bio-nexa.com` API

版本基线：2026-10-01。Base URL：`https://device-api.bio-nexa.com`。

该入口供完成接入后的设备使用。通信设计原始六接口中，证书、同步和退役确认 4 个接口位于本域名；另外，当前生产路由已加入 OTA 下载授权和 Media 上传会话，共 6 个操作。Onboarding 的 2 个接口位于 `onboard-api.bio-nexa.com`。

设备持续上报 Heartbeat、Telemetry、ESG Report、Alarm 等数据，以及接收命令、OTA 和通知，使用 MQTT。完整 Topic、字段、报文示例与联调要求见 [设备 MQTT 联调说明](./iot.bio-nexa.com.md)。

## 认证、请求与错误

- API Gateway Regional 自定义域名启用 mTLS。客户端在 TLS 握手中提供设备 X.509 证书。
- 网关 CA 链验证之后，应用仍按证书 PEM 的 SHA-256 指纹查询 `device_certificates`，验证登记状态、有效期、Device 归属和生命周期。
- 认证身份就是设备；客户端不得通过 Header 或 JSON 自报 `deviceId` 替代证书身份。
- 大多数接口要求证书 `ACTIVE`。Retired 且退役确认待处理的设备只允许调用 Sync 和 Deactivate；其他设备接口拒绝。
- JSON 请求是封闭对象；未知字段返回 `400 VALIDATION_FAILED`。
- UTC 时间戳格式为 `YYYY-MM-DDTHH:mm:ss[.SSS]Z`，日期格式为 `YYYY-MM-DD`。
- 默认 API Gateway `execute-api` Endpoint 应关闭；客户端只使用本自定义域名。

常规 JSON 错误体：

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "The request failed",
    "requestId": "api-gateway-request-id"
  }
}
```

稳定错误码集合包括 `VALIDATION_FAILED`、`UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`、`DEVICE_STATE_NOT_ALLOWED` 和 `INTERNAL_ERROR`。服务端不会向设备暴露 SQL、堆栈、AWS ARN、密钥或内部错误。

示例 `curl` 只说明 TLS 调用形式；证书、私钥和 CA 路径必须来自安全设备存储：

```bash
curl --cert device-cert.pem --key device-private-key.pem \
  --cacert server-ca.pem https://device-api.bio-nexa.com/api/v1/device/certificate/status
```

## 接口总览

| Method | Path | 成功状态 | operationId |
|---|---|---:|---|
| GET | `/api/v1/device/certificate/status` | 200 | `getCertificateStatus` |
| POST | `/api/v1/device/certificate/rotate` | 200 | `rotateCertificate` |
| POST | `/api/v1/device/sync` | 200 | `syncDevice` |
| POST | `/api/v1/device/deactivate` | 200 | `confirmDeactivation` |
| GET | `/api/v1/device/ota/targets/{targetId}/download?token=...` | 307 | `redeemOtaDownloadGrant` |
| POST | `/api/v1/device/media/upload-sessions` | 201 | `createMediaUploadSession` |

## GET `/api/v1/device/certificate/status`

返回当前 mTLS 身份证书的状态，不返回 PEM 或私钥。建议每日调用。

```json
{
  "certificateId": "CERT002",
  "status": "ACTIVE",
  "expiryDate": "2028-01-01",
  "daysRemaining": 365,
  "mqttVerifiedAt": "2026-10-01T03:00:00Z",
  "restVerifiedAt": "2026-10-01T03:00:10Z",
  "rotationDeadlineAt": null,
  "rotationConfirmedAt": null
}
```

| 字段 | 约束 |
|---|---|
| `certificateId` | 当前 mTLS 身份对应证书 ID |
| `status` | `ACTIVE`、`EXPIRING`、`EXPIRED`、`REVOKED` |
| `expiryDate` | UTC `YYYY-MM-DD` |
| `daysRemaining` | 非负 UTC 整日差；过期或撤销时为 0 |
| `mqttVerifiedAt` / `restVerifiedAt` | 当前证书首次合法 Heartbeat / 成功 Sync 的服务器验证时间；未知为 `null` |
| `rotationDeadlineAt` | 新轮换证书双通道确认截止时间；普通证书为 `null` |
| `rotationConfirmedAt` | 双通道确认提交时间；未完成为 `null` |

`EXPIRING` 阈值由部署参数控制，默认 30 天。响应状态：`200`、`401 UNAUTHENTICATED`、`403 FORBIDDEN`、`500 INTERNAL_ERROR`。

## POST `/api/v1/device/certificate/rotate`

以当前 Active 证书申请替换证书。设备收到管理员轮换通知或接近到期时调用。

请求：

```json
{
  "currentCertificateId": "CERT001",
  "csrPem": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----"
}
```

`currentCertificateId` 必须等于当前 mTLS 身份证书 ID。设备先在本地安全存储生成新的 RSA 2048 位或更强密钥并提交签名有效的 PKCS#10 `csrPem`（最多 8192 字符，RSA-SHA256/384/512）。私钥始终留在设备。拒绝与当前证书相同的公钥；跨设备复用公钥返回 `409 CONFLICT`。未知字段或缺失 CSR 返回 `400 VALIDATION_FAILED`。

成功响应：

```json
{
  "certificateId": "CERT002",
  "certificatePem": "-----BEGIN CERTIFICATE-----...",
  "certificateChain": "-----BEGIN CERTIFICATE-----\n<issuing CA and remaining chain>\n-----END CERTIFICATE-----",
  "effectiveDate": "2027-01-01",
  "expiryDate": "2028-01-01"
}
```

响应只包含公开证书，不返回私钥。`certificateChain` 顺序为签发 CA → 上级 CA → 根 CA，不含叶证书。证书 CN/SAN 由服务端绑定 `deviceId`。设备核对新证书公钥与本地新私钥匹配，保存完整链，再用同一张新叶证书执行：

1. 连接 AWS IoT（设置正确 SNI）并发布合法 Heartbeat。
2. 向本 REST 域名调用 `POST /api/v1/device/sync` 并成功取得快照。

两项可任意顺序到达。新旧证书在原证书各自有效期内并行，新证书从签发记录创建时起最多有 24 小时确认窗口；截止时间可用新证调用证书状态接口查询。仅一项成功不会撤销旧证。两项服务器验证完成且在截止前，事务撤销旧证、完成管理员轮换请求并登记 AWS `INACTIVE` 意图；Sweeper 持续重试 AWS 停用，状态摘要显示确认时间。数据库撤销立即阻止旧证的应用请求，AWS 停用存在异步延迟。

恰好到达截止时间时，未确认的新证即在 REST 和 MQTT 应用认证层被拒绝；Sweeper 撤销新证并重试 AWS 停用，旧证保留原状态与原有效期。设备应保留旧密钥直到确认成功；超时后用旧证及另一份新 CSR 重试，旧证本已过期或被撤销时需运维恢复。

相同 CSR 在尚未交付的请求中可恢复一次性公开证书包；交付结果不确定时撤销替换证并有界重签。已提交交付且双通道未完成时，重复 Rotate 返回 `409 CONFLICT`，不同 CSR 也不能覆盖进行中的轮换。服务端提交响应代表完成序列化和状态提交，无法证明客户端已收到网络响应；丢失已提交响应需运维恢复。未知、不确定或过期包不重新下载。
响应状态：`200`、`400 VALIDATION_FAILED`、`401 UNAUTHENTICATED`、`403 FORBIDDEN`、`409 CONFLICT`、`500 INTERNAL_ERROR`。

## POST `/api/v1/device/sync`

返回 Assignment、Device、License、Device Users、Configuration 和 Operational Status 的完整事实快照。成功响应完成序列化后，服务器按当前 mTLS 证书记录 `restVerifiedAt`；认证、参数校验或快照构建失败不记录。该时间证明服务器成功处理此证书请求，不是设备收包 ACK。若新证已有 MQTT 验证且仍在轮换窗口内，本次 Sync 同时触发轮换确认。V1 不做增量裁剪，不返回 `304`；`lastSyncTime` 只作为请求回显和兼容信息。

请求体可省略。存在时只能包含：

```json
{
  "lastSyncTime": "2026-08-01T10:00:00Z"
}
```

首次同步也可使用 `{ "lastSyncTime": null }`。

成功响应示例：

```json
{
  "deviceId": "DEV001",
  "snapshotAt": "2026-09-24T03:00:00Z",
  "lastSyncTime": "2026-08-01T10:00:00Z",
  "etag": "sha256-hex-value",
  "assignment": {
    "assignmentId": "ASN001",
    "customerId": "CUS001",
    "customerName": "ABC Hotel",
    "siteId": "SITE001",
    "siteName": "Hotel A Kitchen",
    "region": "APAC",
    "subregion": null,
    "assignedAt": "2026-01-01T00:00:00Z",
    "endedAt": null
  },
  "device": {
    "deviceId": "DEV001",
    "alias": "Kitchen Processor 01",
    "serialNumber": "BNX202600001",
    "model": "BNX-100",
    "firmwareVersion": "1.2.3"
  },
  "license": {
    "licenseId": "LIC001",
    "status": "ACTIVE",
    "validFrom": "2026-01-01",
    "validTo": "2027-12-31",
    "entitlements": ["REMOTE_CONTROL", "OTA", "ESG_REPORTING"],
    "signature": "...",
    "version": 1,
    "effective": true
  },
  "deviceUsers": [
    {
      "userId": "USR001",
      "username": "operator01",
      "displayName": "Kitchen Operator",
      "passwordHash": "$argon2id$v=19$m=32768,t=3,p=1$...$...",
      "status": "ACTIVE"
    }
  ],
  "configuration": {
    "heartbeatInterval": 60,
    "telemetryInterval": 30,
    "cameraRefreshInterval": 1,
    "temperatureThreshold": 80
  },
  "operationalStatus": {
    "lifecycleStatus": "Active",
    "operationalStatus": "Active",
    "connectivity": "ONLINE",
    "lastHeartbeatAt": "2026-09-24T02:59:30Z",
    "syncIntervalSeconds": 300
  }
}
```

必填顶层域是 `assignment`、`device`、`license`、`deviceUsers`、`configuration`、`operationalStatus`。未分配、未许可或无配置时，对应域为 `null`；无设备用户时为 `[]`。`deviceId`、`snapshotAt`、`lastSyncTime`、`etag` 是兼容元数据。

关键约束：

- License 状态：`NO_LICENSE`、`DRAFT`、`ISSUED`、`ACTIVE`、`EXPIRING_SOON`、`RENEWED`、`EXPIRED`、`REVOKED`；Entitlement 仅为 `REMOTE_CONTROL`、`OTA`、`ESG_REPORTING`。
- Device User `passwordHash` 是设备本地专用 Argon2id PHC 值，不是 Cognito 或云端账号密码 Hash；状态为 `ACTIVE` 或 `DISABLED`。
- Configuration V1 固定四字段：Heartbeat 10～900 秒，Telemetry 5～3600 秒，Camera Refresh 1～1440 分钟，Temperature Threshold 0～120 °C。
- `etag` 是稳定域内容的 SHA-256 内容版本；`snapshotAt`、连接状态和最后心跳等易变域不参与。
- 同步节奏：Active 300 秒、Suspended 900 秒、Maintenance 900 秒；重新连接或收到同步类 MQTT Notification 后立即调用。

响应状态：`200`、`400 VALIDATION_FAILED`、`401 UNAUTHENTICATED`、`403 FORBIDDEN`、`500 INTERNAL_ERROR`。

## POST `/api/v1/device/deactivate`

确认管理员已发起的设备退役，并完成证书停用。**请求必须完全无 Body**；发送 `{}` 也返回 `400 VALIDATION_FAILED`。

成功响应示例：

```json
{
  "data": {
    "deviceId": "DEV001",
    "lifecycleStatus": "Retired",
    "retirement": {
      "retirementId": "RET001",
      "status": "CONFIRMED",
      "reason": "Device replaced",
      "initiatedBy": "administrator-id",
      "initiatedAt": "2026-09-23T00:00:00Z",
      "confirmedAt": "2026-09-24T03:00:00Z",
      "completionMethod": "DEVICE_CONFIRM",
      "certificateRevokedAt": "2026-09-24T03:00:00Z"
    },
    "certificates": [
      {
        "certificateId": "CERT001",
        "fingerprint": "sha256-fingerprint",
        "status": "REVOKED",
        "revokedAt": "2026-09-24T03:00:00Z"
      }
    ],
    "replayed": false
  },
  "meta": {
    "requestId": "api-gateway-request-id",
    "timestamp": "2026-09-24T03:00:00Z"
  }
}
```

重复确认幂等返回 `200`，`data.replayed=true`。`completionMethod` 枚举为 `DEVICE_CONFIRM`、`FORCE_COMPLETE`、`UNCONFIRMED_TIMEOUT`。响应不含 PEM、私钥或证书包。

响应状态：`200`、`400 VALIDATION_FAILED`、`401 UNAUTHENTICATED`、`404 NOT_FOUND`、`409 DEVICE_STATE_NOT_ALLOWED/CONFLICT`、`500 INTERNAL_ERROR`。

## GET `/api/v1/device/ota/targets/{targetId}/download`

兑换设备通过 MQTT 获得的、一次性且目标绑定的 OTA 下载授权。

| 参数 | 位置 | 约束 |
|---|---|---|
| `targetId` | Path | 必填，非空 |
| `token` | Query | 必填，32～128 字符；服务端只保存 SHA-256 |

```http
GET /api/v1/device/ota/targets/OTATGT001/download?token=random-download-grant HTTP/1.1
Host: device-api.bio-nexa.com
```

成功时原子消费 grant 并返回：

```http
HTTP/1.1 307 Temporary Redirect
Location: https://signed-s3-url.example/...
Cache-Control: no-store
```

客户端只应跟随 HTTPS `Location`，且不得缓存或复用 token。校验包括 mTLS deviceId、targetId、packageId、有效期、未消费和未撤销。响应状态：`307`、`400`、`401`、`403`、`404`、`409`、`500`。

## POST `/api/v1/device/media/upload-sessions`

创建设备专属 S3 对象前缀下的短期预签名上传会话。该接口只签发上传会话，不采集、转码或提供实时流媒体。

请求：

```json
{
  "mediaType": "IMAGE",
  "fileName": "capture-001.jpg",
  "sizeKb": 120,
  "sizeBytes": 122880,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

| 字段 | 约束 |
|---|---|
| `mediaType` | `IMAGE` 或 `VIDEO` |
| `fileName` | 1～128 字符，仅 `[A-Za-z0-9._-]`；禁止路径分隔符和穿越 |
| `sizeKb` | 正整数；必须等于 `ceil(sizeBytes/1024)`；IMAGE 最大 10240，VIDEO 最大 204800 |
| `sizeBytes` | 正整数，绑定到预签名 PUT 的 `Content-Length` |
| `sha256` | 64 位十六进制；上传后服务端重算 |

成功返回 `201`：

```json
{
  "data": {
    "sessionId": "MEDSES001",
    "mediaType": "IMAGE",
    "fileName": "capture-001.jpg",
    "sizeKb": 120,
    "sizeBytes": 122880,
    "objectPath": "media/CUS001/DEV001/MEDSES001/capture-001.jpg",
    "uploadUrl": "https://signed-s3-upload-url.example/...",
    "uploadUrlExpiresAt": "2026-09-24T03:15:00Z",
    "createdAt": "2026-09-24T03:00:00Z"
  },
  "meta": {
    "requestId": "api-gateway-request-id",
    "timestamp": "2026-09-24T03:00:00Z"
  }
}
```

上传 URL 有效期 900 秒。`objectPath` 由服务端生成，设备后续 Media 元数据必须逐字符使用该值，不能指定任意 Bucket/Key。响应状态：`201`、`400`、`401`、`403`、`409`、`500`。

## 可执行契约与实现

- 证书：`contracts/rest/device-certificate-api.json`
- 同步：`contracts/rest/device-sync-api.json`
- 退役确认：`contracts/rest/device-deactivate-api.json`
- OTA 下载：`contracts/rest/device-ota-api.json`
- Media 上传：`contracts/rest/device-media-api.json`
- 生产路由：`apps/cloud-api/src/runtime/delivered-operations.ts`
- Lambda 适配器：`apps/cloud-api/src/runtime/device-lambda.ts`
