# 设备实时图片预览与事件告警留档接口设计

方案已于 2026-11-06 获用户确认。面向厨房 App、客户平台和云端联调人员，新增接口和参数按本方案作为开发基线。具体任务与阶段验收见 [开发计划](./device-image-development-plan.md)。

实时预览由厨房 App 直接向设备 REST 上传 JPEG 的 Base64，云端只保留一张短时有效的最新帧，客户平台读取后直接渲染。事件或告警触发的照片继续走 S3 归档，上传会话记录触发来源，平台从告警或事件定位已登记的图片。两个流程可以同时进行，预览帧使用独立限频和短期存储。

| 用途 | 数据路径 | 存储 |
|---|---|---|
| 实时预览 | App 抓拍 → HTTPS POST Base64 → 平台 GET 最新帧并渲染 | 每设备一张最新帧，逻辑有效期 10 秒 |
| 事件或告警留档 | MQTT 上报触发消息 → REST 申请上传会话 → HTTPS PUT JPEG 到 S3 → MQTT `media` → 云端登记和关联 | S3 文件与既有 Media 元数据，按现行归档策略保留 |

现有接口基线见 [Device REST](./device-api.bio-nexa.com.md)、[MQTT 联调说明](./iot.bio-nexa.com.md) 和 [媒体上传策略](../../contracts/media/media-upload-policy.json)。

## 1. 实时预览

### 1.1 查看会话和刷新参数

首版通过 REST 短租约按需启停。平台页面打开预览时申请租约，设备轮询查看状态后开始抓拍。多个页面共享同一设备的一路帧流，每页各自续租。页面关闭时主动释放租约，异常退出时由租约到期停止。每次从无有效租约变为有有效租约，云端创建新的 `streamId`。

| 参数 | 首版建议 | 客户端行为 |
|---|---|---|
| 设备状态查询 | 每 5 秒一次 | 仅对启用此能力的设备执行。收到 `IDLE`、租约到期或上传返回会话失效时停止抓拍 |
| 抓拍和上传 | 默认 2 秒一帧 | 上一帧仍在上传时跳过本次，后续发送新帧。服务端允许至多每秒接收一张新帧 |
| 页面读图 | 默认每 2 秒一次 | 每个页面保持一个在途请求。已有帧时随请求带上 `knownFrameId` |
| 查看租约 | 30 秒，每 10 秒续租 | 平台页面只在正在查看时续租。最后一份租约释放或到期后，最新帧立即停止对外可见 |
| 最新帧有效期 | 10 秒 | 以采集时间加 10 秒和服务端接收时间加 10 秒中的较早时间为准。页面到期清空画面并显示等待状态 |
| 图片规格 | JPEG，默认长边 640 px，最大 128 KiB 原图 | 保持纵横比。超限时由 App 调整压缩率或缩小后再提交 |

启用但无人查看的在线设备按 5 秒一次查询，每台约产生 17,280 次状态请求/天。首帧需要经过一次设备状态查询、采集上传和页面读取。上线前按预计启用台数和同时查看数验证请求量及首帧延迟。

### 1.2 路由和认证

设备端使用 `device-api.bio-nexa.com`，以有效设备证书执行 mTLS 与应用层证书校验。设备身份从证书解析，接口只操作自身。首版允许已分配 Customer 且生命周期允许设备媒体操作、运行状态为 Active 或 Maintenance 的设备。挂起、退役、取消分配或撤销访问时，云端拒绝后续访问并使对应预览失效。

平台端使用 `api.bio-nexa.com`，以 Cognito JWT 校验设备可见范围和媒体读取权限。租约绑定设备与当前用户，页面打开时生成自己的 `viewerId`。每次续租、读取及释放都重新校验权限。跨租户或设备不可见返回 `404`，权限不足返回 `403`。

| 调用方 | 方法与路径 | 请求 | 成功响应 |
|---|---|---|---|
| 平台 | `PUT /api/v1/admin/devices/{deviceId}/live-image/viewers/{viewerId}` | `viewerId` 为 UUID，空请求体 | `200`，返回 `streamId`、`leaseExpiresAt`、`renewAfterSeconds: 10`、`readIntervalMs: 2000`。同一页面重复调用续租 |
| 平台 | `DELETE /api/v1/admin/devices/{deviceId}/live-image/viewers/{viewerId}` | 空请求体 | `204`，本用户租约已释放或已到期 |
| 设备 | `GET /api/v1/device/live-image/state` | 无参数 | `200`，无人查看时返回 `state: IDLE` 和 `pollIntervalMs: 5000`。有人查看时另含 `streamId`、`activeUntil`、`uploadIntervalMs: 2000`、`maxImageBytes: 131072`，`state` 为 `ACTIVE` |
| 设备 | `POST /api/v1/device/live-image/frames` | JSON，见下节 | `200`，返回帧 ID、接收时间、过期时间和是否为重放 |
| 平台 | `GET /api/v1/admin/devices/{deviceId}/live-image/latest?viewerId={viewerId}&knownFrameId={frameId}` | `viewerId` 必填，`knownFrameId` 可省略 | `200`，返回 `READY`、`UNCHANGED` 或 `WAITING_FRAME` |

`activeUntil` 为当前设备所有有效查看租约中最晚的截止时刻。设备可在此时间之前按已知状态抓拍，上传入口仍实时校验查看租约。平台读取请求在当前页面租约无效时返回 `409 LIVE_VIEWER_EXPIRED`，页面清空画面，若仍打开则重新申请租约。

### 1.3 设备上传帧

请求使用 `Content-Type: application/json`。下面示例的 `imageBase64` 用占位字符串代替完整 JPEG。

```json
{
  "streamId": "3874df1c-287c-43ee-9f18-6b25d26b9a08",
  "frameId": "c674f6a1-9edc-47f0-8a48-2629a9e8c911",
  "capturedAt": "2026-11-04T07:17:26.000Z",
  "mimeType": "image/jpeg",
  "imageBase64": "<JPEG 的标准 Base64>"
}
```

字段均必填。云端拒绝未知字段。`frameId` 为每次新抓拍生成的 UUID，网络重试沿用原 ID 和完整请求。`imageBase64` 使用标准 Base64，带必要的填充，省去 `data:image/jpeg;base64,` 前缀及空白。HTTP 请求体上限为 180 KiB，解码后的 JPEG 上限为 128 KiB。云端验证 Base64 和 JPEG 可解码性，宽高各最多 1920 px，总像素最多 2,073,600。设备使用 UTC，服务端接受最多 2 秒的超前时间，已过 10 秒有效期的帧直接丢弃。

成功响应示例使用设备和管理 API 的 `data`、`meta` 封装。

```json
{
  "data": {
    "frameId": "c674f6a1-9edc-47f0-8a48-2629a9e8c911",
    "receivedAt": "2026-11-04T07:17:26.400Z",
    "expiresAt": "2026-11-04T07:17:36.000Z",
    "replayed": false
  },
  "meta": {
    "requestId": "req-live-frame-01",
    "timestamp": "2026-11-04T07:17:26.400Z"
  }
}
```

云端按设备和 `streamId` 原子比较并替换最新帧。`capturedAt` 必须晚于该会话最近接受的帧，较旧或同一时刻的不同帧返回 `409 STALE_FRAME`。同 `frameId` 且内容一致的近期重传返回原接收结果和原过期时间，`replayed: true`，不延长有效期。相同 ID 但内容不同返回 `409 FRAME_CONFLICT`。去重摘要自接收起保留 15 秒，最新采集时间水位保留至本次会话结束。新会话拒绝上一会话的帧，即使其采集时间仍有效。

### 1.4 页面读图和异常响应

```json
{
  "data": {
    "state": "READY",
    "streamId": "3874df1c-287c-43ee-9f18-6b25d26b9a08",
    "frameId": "c674f6a1-9edc-47f0-8a48-2629a9e8c911",
    "capturedAt": "2026-11-04T07:17:26.000Z",
    "expiresAt": "2026-11-04T07:17:36.000Z",
    "mimeType": "image/jpeg",
    "imageBase64": "<JPEG 的标准 Base64>"
  },
  "meta": {
    "requestId": "req-live-read-01",
    "timestamp": "2026-11-04T07:17:28.000Z"
  }
}
```

页面用已校验的 MIME 类型拼装 `data:image/jpeg;base64,...` 供图片组件渲染。`UNCHANGED` 返回 `state`、`streamId`、`frameId`、`expiresAt`，页面继续显示当前帧，截止时间保持原值。`WAITING_FRAME` 返回 `state` 和 `streamId`，表示本次会话尚无帧或帧已过期。页面忽略上一会话的迟到响应，按服务端 `meta.timestamp` 和 `expiresAt` 的差值扣除请求往返耗时，设置本地清除定时器。下一次请求失败时，清除定时器仍生效。预览接口返回 `Cache-Control: no-store`，访问日志只记请求标识、结果和字节数。

| HTTP | 错误码 | 客户端处理 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 修正字段、编码或时钟 |
| 401 / 403 / 404 | `UNAUTHENTICATED` / `FORBIDDEN` / `NOT_FOUND` | 按设备证书或平台身份、设备状态和权限处理 |
| 409 | `LIVE_STREAM_INACTIVE` | 设备停止上传，重新读取查看状态 |
| 409 | `LIVE_VIEWER_EXPIRED` | 页面清空画面，仍处于查看状态时重新申请租约 |
| 409 | `STALE_FRAME` / `FRAME_CONFLICT` | 丢弃该帧，检查采集时间或帧 ID 生成逻辑 |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 降低图片大小或改用 JPEG JSON 请求 |
| 429 | `RATE_LIMITED` | 按 `Retry-After` 等待后发送新帧 |
| 503 | `TEMPORARILY_UNAVAILABLE` | 退避，待恢复后发送新帧 |

应用错误沿用 Device REST 的 `error.code`、`error.message`、`error.requestId` 结构。TLS 握手失败和网关提前拒绝由客户端按传输错误处理。云端使用带 TTL 的共享临时存储保留最新帧，读取时显式检查有效期及租约。最新帧进入终端页面内存，事件留档使用单独抓拍流程。

## 2. Event 和 Alarm 图片留档

### 2.1 触发来源和关联键

App 触发选定的本地业务事件或 `alarm.status=ACTIVE` 时，先为原始 MQTT 消息生成并持久保存 `meta.id`，随后抓拍一张 JPEG。原 MQTT 消息按原契约优先发送，图片链路失败时仍独立处理原事件或告警。首版每条触发消息最多关联一张照片。触发拍摄的事件类型和告警代码由设备方与业务方确认，验收至少覆盖一类 Event 和一类 Alarm。

上传会话增加可选 `triggerRef`，其 `kind` 为 `EVENT` 或 `ALARM`，`messageId` 为原始 MQTT 消息的 `meta.id`，逐字符匹配。设备和 Customer 从认证和设备台账取得。Alarm 关联到创建该记录的 `ACTIVE` 消息。告警确认或清除后可继续查看原图片，`CLEARED` 消息只处理告警状态。现有事件和告警记录已分别保存原消息 ID 到 `sourceMessageId`，可直接用于查找。 [告警与事件数据模型](../../packages/database/prisma/schema.prisma#L718)

### 2.2 设备请求和响应

沿用 `POST /api/v1/device/media/upload-sessions` 和 mTLS。添加 `triggerRef` 的请求示例中，文件大小与 SHA-256 为演示值，实际应从同一 JPEG 计算。

```json
{
  "mediaType": "IMAGE",
  "fileName": "alarm-capture-184.jpg",
  "sizeKb": 120,
  "sizeBytes": 122880,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "triggerRef": {
    "kind": "ALARM",
    "messageId": "ALM-DEV001-184"
  }
}
```

- `201` 使用现有会话响应，含 `sessionId`、`mediaType`、`fileName`、`sizeKb`、`sizeBytes`、`objectPath`、`uploadUrl`、`uploadUrlExpiresAt`、`createdAt`，并回显 `triggerRef`。省略 `triggerRef` 时执行原有会话流程。
- 云端以 `customerId + deviceId + triggerRef.kind + triggerRef.messageId` 串行处理并发申请，持久绑定首次申报的文件类型、文件名、精确字节数和 SHA-256。相同申报且会话有效时返回 `200` 与该会话，URL 的截止时间保持原值，配额只计一次。申报改变返回 `409 MEDIA_TRIGGER_CONFLICT`。
- 已登记时返回 `409 MEDIA_ALREADY_REGISTERED`，错误明细提供已有 `mediaId`，设备结束本次上传任务。未登记且会话过期时可用同一申报创建新会话，使用新路径并计入当日配额。旧会话按原有过期规则处理。无效引用格式或对 `VIDEO` 使用引用返回 `400 VALIDATION_FAILED`。
- 图片上限 10 MiB，上传 URL 有效期 900 秒，每台设备每 UTC 自然日最多签发 100 个归档上传会话。App 按现有签名要求对原 JPEG 执行 HTTPS PUT，随后在会话有效期内发送 MQTT `media`。 [设备上传接口](./device-api.bio-nexa.com.md#post-apiv1devicemediaupload-sessions) · [现有媒体实现](../BE-MED-01-Media上传会话与元数据API.md)

MQTT `media` 保持现有字段。设备按会话返回值填 `objectPath` 和文件信息，云端用该路径定位已绑定 `triggerRef` 的会话。

App 持久保存触发 ID、原始 JPEG 和上传进度。收到 PUBACK 后，可用同一会话申请请求查询进度，直到收到 `MEDIA_ALREADY_REGISTERED`。该响应确认图片已登记，关联结果由云端随后处理。MQTT 重传仍遵循现有时间窗、报文内容和序号规则。超时后的新上传尝试使用新会话、新路径和新 `media` 报文，并保留原触发引用。原触发消息未成功处理时，图片进入待关联流程。 [MQTT 时间与重试规则](./iot.bio-nexa.com.md#31-时间重试与重复消息)

```json
{
  "meta": {
    "id": "MED-DEV001-907",
    "ts": "2026-11-04T07:17:30.000Z",
    "seq": 907
  },
  "data": {
    "mediaType": "IMAGE",
    "captureTime": "2026-11-04T07:17:26.000Z",
    "fileName": "alarm-capture-184.jpg",
    "objectPath": "media/CUS001/DEV001/MEDSES001/alarm-capture-184.jpg",
    "sizeKb": 120
  }
}
```

### 2.3 云端登记与平台查询

Media Handler 完成会话、对象、大小与 Hash 校验后，登记图片和待关联记录。使用 `kind` 选择 Alarm 或 DeviceEvent，再以同 Customer、同设备的 `sourceMessageId` 精确匹配。原始 MQTT 上报、S3 上传和元数据消费独立完成，云端以事务和唯一键确保重复投递最多登记一张关联图。告警代码和时间仅用于展示。同一代码多次触发时，每次图片分别挂在各自的告警记录。

| 关联状态 | 处理 |
|---|---|
| `PENDING` | 图片已校验登记，原事件或告警可能仍在处理。由后台任务重试，首次登记后最多等待 24 小时 |
| `LINKED` | 已匹配原始记录，保存 `mediaId` 与云端 `alarmId` 或 `eventId` 的关联 |
| `UNMATCHED` | 超过等待期限、目标归属不符或引用了清除消息。保留已登记图片及排查状态，关联查询返回空结果 |

拟在 `GET /api/v1/admin/alarms/{alarmId}` 及 `GET /api/v1/admin/events` 的对应记录增加可选 `evidenceImage`。同时具备原记录读取权限和 `media:read` 时，返回 `{ "mediaId": "…", "captureTime": "…", "status": "AVAILABLE" }`，尚无匹配则返回 `null`。图片按保留策略删除后，关联可继续显示 `status: "DELETED"`，下载入口遵循现有删除规则。前端以 `mediaId` 调用已有 `GET /api/v1/admin/media/{mediaId}/download-url`。平台根据源记录和媒体各自的权限校验租户范围。 [告警和事件查询契约](../../contracts/rest/admin-alarm-api.json) · [媒体下载契约](../../contracts/rest/admin-media-api.json)

## 3. 联调验收

| 用例 | 通过条件 |
|---|---|
| 两个页面同时看同一设备 | 两个租约共享同一 `streamId` 和帧。关闭一个页面后另一个继续，最后一个退出或租约过期后设备停止抓拍，平台清空画面 |
| 连续预览和过期 | 观察约 2 秒刷新。暂停上传后，页面在最后一帧有效期内显示图片，到期后清空。重开预览时不展示上一会话的帧 |
| 异常预览帧 | 重放、倒序、超限和频率超标符合响应定义。无设备凭据、跨租户及无有效租约访问均被拒绝 |
| 告警与事件分别留档 | 两条链路均完成 S3 PUT 和 MQTT `media` 登记。连续两条同 code 告警及相近时间的事件各自关联正确，告警清除后仍可查看对应照片 |
| 上报乱序、会话重试和设备重启 | 先登记图片或先入库触发消息均能关联。有效会话重试不增加配额，过期后按规则重办。设备从持久队列恢复同一触发 ID、图片和 MQTT 报文，重复消费不增加关联记录 |
| 双链路同时运行 | 连续预览期间触发告警，S3 留档独立完成，预览未消耗归档上传配额 |

已确认按 2 秒刷新、10 秒帧有效期及每条触发消息一张照片实施。首帧等待目标、启用设备规模及 Event 和 Alarm 拍摄白名单在开发计划对应任务中补齐。接口实现、目标环境和真机验证状态均为 `NOT_RUN`。
