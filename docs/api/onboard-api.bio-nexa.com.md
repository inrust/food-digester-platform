# `onboard-api.bio-nexa.com` API

版本基线：2026-09-24。Base URL：`https://onboard-api.bio-nexa.com`。

该入口只负责设备首次接入申请、审批状态轮询和一次性证书包领取。管理员审批使用 `api.bio-nexa.com`，不在本入口。接口实现对应 BE-ONB-01/03；首次合法 Heartbeat 完成接入和 24 小时超时收敛由后台流程处理。

## 首次申请前：Token 从哪里来

设备无法通过 `/onboarding/request` 自行取得 Token，因为此接口在创建申请前就要求 Token。制造或运维方必须先完成以下独立步骤：

1. 将设备序列号登记到云端设备库存，并确认设备处于可接入状态。
2. 在受控的制造/运维执行环境中，为该序列号设置到期时间并调用 `issueOnboardingToken(client, { serialNumber, expiresAt })`。该函数先检查库存，再生成 `fdp_onb_` 加 43 位 base64url 字符的随机 Token；数据库仅保存 SHA-256 Hash、绑定序列号和有效期。明文仅在签发结果中出现一次。
3. 通过事先约定的安全交付方式将明文 Token 交给对应设备：例如制造阶段写入设备受保护存储，或现场由授权人员通过受控配网流程注入。若选用 QR，需定义由谁展示、谁扫描以及如何防止旁观或重复领取；本仓库尚未实现这条交付链。
4. 设备读取已交付的完整 Token，作为 `Authorization: Bearer <ONBOARDING_TOKEN>` 调用申请和状态接口。管理员审核发生在申请创建之后，与 Token 签发是两个步骤。

当前仓库**只有签发函数，没有供制造/运维人员使用的正式签发命令、管理页面或对外签发 API，也没有设备侧 Token 交付实现**。因此不能仅凭这两份 REST 文档直接开始真实设备首次接入。联调前需由双方明确签发责任人、有效期、安全交付方式和失效/补发流程，并在测试环境准备已登记设备及与之绑定的测试 Token。不要在聊天、普通工单、日志或会议纪要中传递明文 Token。

## 认证、格式与安全要求

- 所有请求使用 `Authorization: Bearer fdp_onb_...`。Token 一次一机，与库存序列号绑定；服务端只保存 Hash。
- 下文的 `<ONBOARDING_TOKEN>` 是占位符，应替换为按上一节流程交付给该设备的完整明文 Token。同一 Token 用于提交申请和轮询状态，不需要管理员审批后再更换。
- 请求和 JSON 响应使用 `Content-Type: application/json`。未知 JSON 字段会被拒绝。
- 默认共享限频为每 Token 每分钟 30 次、每来源 IP 每分钟 60 次；超过限制返回 `429 RATE_LIMITED`。
- Token 缺失、非法、过期、撤销、核销或与序列号不符统一返回 `401 UNAUTHENTICATED`，客户端不能依赖详细失败原因。
- `GET status` 由 Token 隐式定位申请，不接受 `requestId` Query 参数。
- `APPROVED` 中的 `privateKey` 只交付一次。设备不得记录到普通日志、Telemetry、崩溃报告或审计中，应立即写入受保护 Keystore。
- 建议设备每 30 秒轮询状态，直至 `APPROVED` 或 `REJECTED`；遇到 `429` 应尊重限频并退避。

通用错误体：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Safe message for the client",
    "requestId": "api-gateway-request-id"
  }
}
```

稳定错误码集合包括 `VALIDATION_FAILED`、`UNAUTHENTICATED`、`NOT_FOUND`、`CONFLICT`、`DEVICE_STATE_NOT_ALLOWED`、`RATE_LIMITED` 和 `INTERNAL_ERROR`。

## 接口总览

| Method | Path | 成功状态 | operationId |
|---|---|---:|---|
| POST | `/api/v1/device/onboarding/request` | 201；幂等重放 200 | `submitOnboardingRequest` |
| GET | `/api/v1/device/onboarding/status` | 200 | `getOnboardingStatus` |

## POST `/api/v1/device/onboarding/request`

提交设备资料并创建 `PENDING` 申请。本接口不审批、不签发证书，也不产生 AWS IoT 资源。相同设备的重复或并发提交幂等返回原 `requestId`。

### 请求

```http
POST /api/v1/device/onboarding/request HTTP/1.1
Host: onboard-api.bio-nexa.com
Authorization: Bearer <ONBOARDING_TOKEN>
Content-Type: application/json
```

```json
{
  "serialNumber": "BNX202600001",
  "model": "BNX-100",
  "hardwareVersion": "1.0",
  "manufacturer": "Bio-Nexa",
  "manufactureDate": "2026-07-01"
}
```

| 字段 | 必填 | 约束 |
|---|---:|---|
| `serialNumber` | 是 | `^[A-Za-z0-9-]{1,64}$`；必须等于 Token 绑定的库存序列号 |
| `model` | 是 | 1～64 字符 |
| `hardwareVersion` | 是 | 1～32 字符 |
| `manufacturer` | 是 | 1～128 字符 |
| `manufactureDate` | 是 | `YYYY-MM-DD`，不得晚于当前日期 |

### 成功响应

首次创建返回 `201`，幂等重放返回 `200`，Body 相同：

```json
{
  "requestId": "REQ001",
  "status": "PENDING"
}
```

### 响应状态

| HTTP | 错误码/含义 |
|---:|---|
| 200 | 已存在 `PENDING` 申请，幂等返回原记录 |
| 201 | 已创建申请 |
| 400 | `VALIDATION_FAILED`：字段、格式或未知字段非法 |
| 401 | `UNAUTHENTICATED`：Token 认证失败 |
| 404 | `NOT_FOUND`：库存中无此序列号 |
| 409 | `DEVICE_STATE_NOT_ALLOWED`：设备已经接入或生命周期不允许申请 |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

## GET `/api/v1/device/onboarding/status`

查询 Token 对应的唯一申请。内部 Provisioning 不作为外部状态暴露：申请已批准但证书包尚未就绪时仍返回 `PENDING`。

### 请求

```http
GET /api/v1/device/onboarding/status HTTP/1.1
Host: onboard-api.bio-nexa.com
Authorization: Bearer <ONBOARDING_TOKEN>
```

请求不得携带正文，也不需要 Query 参数。

### PENDING 响应

```json
{
  "status": "PENDING"
}
```

### REJECTED 响应

```json
{
  "status": "REJECTED",
  "reason": "Serial Number Not Authorized"
}
```

证书包存储后 24 小时仍没有首个合法 Heartbeat 时，外部稳定映射为：

```json
{
  "status": "REJECTED",
  "reason": "ONBOARDING_TIMEOUT"
}
```

超时后重新申请必须使用新 Token。

### APPROVED 响应

```json
{
  "status": "APPROVED",
  "deviceId": "DEV001",
  "certificate": {
    "certificatePem": "-----BEGIN CERTIFICATE-----...",
    "privateKey": "-----BEGIN PRIVATE KEY-----..."
  },
  "mqtt": {
    "endpoint": "xxxxx.iot.ap-southeast-1.amazonaws.com"
  },
  "configuration": {
    "heartbeatInterval": 60
  }
}
```

`certificate`、`mqtt`、`configuration` 以及各自必填字段都是封闭对象，不允许额外字段。成功响应提交后，服务端销毁证书包密文并核销 Token。响应提交状态不确定时，服务端执行撤证和重签恢复；客户端不能假定重复轮询一定返回同一私钥。

设备收到批准响应后应：安全保存证书和私钥，使用返回的 MQTT Endpoint 连接 AWS IoT，随后发布首次合法 Heartbeat。首次 Heartbeat 才是 Onboarding 完成标志。

### 响应状态

| HTTP | 错误码/含义 |
|---:|---|
| 200 | 返回 `PENDING`、`REJECTED` 或 `APPROVED` |
| 400 | `VALIDATION_FAILED` |
| 401 | `UNAUTHENTICATED`：Token 已核销也使用此状态 |
| 404 | `NOT_FOUND`：Token 无对应申请 |
| 409 | `CONFLICT`：证书包已领取或已过期，一次性领取失败关闭 |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

## 可执行契约与实现

- OpenAPI：`contracts/rest/device-onboarding-api.json`
- Lambda 路由：`apps/cloud-api/src/runtime/device-onboarding-lambda.ts`
- Request Handler：`apps/cloud-api/src/onboarding/handler.ts`
- Status Handler：`apps/cloud-api/src/onboarding/status-handler.ts`
