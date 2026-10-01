# `device-api.bio-nexa.com` API

版本基线：2026-09-24。Base URL：`https://device-api.bio-nexa.com`。

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
  "daysRemaining": 365
}
```

| 字段 | 约束 |
|---|---|
| `certificateId` | 当前 mTLS 身份对应证书 ID |
| `status` | `ACTIVE`、`EXPIRING`、`EXPIRED`、`REVOKED` |
| `expiryDate` | UTC `YYYY-MM-DD` |
| `daysRemaining` | 非负 UTC 整日差；过期或撤销时为 0 |

`EXPIRING` 阈值由部署参数控制，默认 30 天。响应状态：`200`、`401 UNAUTHENTICATED`、`403 FORBIDDEN`、`500 INTERNAL_ERROR`。

## POST `/api/v1/device/certificate/rotate`

以当前 Active 证书申请替换证书。设备收到管理员轮换通知或接近到期时调用。

请求：

```json
{
  "currentCertificateId": "CERT001"
}
```

`currentCertificateId` 必须等于当前 mTLS 身份证书 ID。

成功响应：

```json
{
  "certificateId": "CERT002",
  "certificatePem": "-----BEGIN CERTIFICATE-----...",
  "privateKey": "<PRIVATE_KEY_PEM>",
  "effectiveDate": "2027-01-01",
  "expiryDate": "2028-01-01"
}
```

新私钥只在本响应出现一次。设备应将新材料写入 Keystore，使用新证书重新连接 AWS IoT，并发布合法 Heartbeat。Heartbeat 确认后旧证书停用并销毁新证书包。切换确认前处于双证书窗口；同一旧证书存在未确认轮换时，重复请求返回 `409 CONFLICT`，不会无限创建新证书。

响应状态：`200`、`400 VALIDATION_FAILED`、`401 UNAUTHENTICATED`、`403 FORBIDDEN`、`409 CONFLICT`、`500 INTERNAL_ERROR`。

## POST `/api/v1/device/sync`

返回 Assignment、Device、License、Device Users、Configuration 和 Operational Status 的完整事实快照。V1 不做增量裁剪，不返回 `304`；`lastSyncTime` 只作为请求回显和兼容信息。

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
