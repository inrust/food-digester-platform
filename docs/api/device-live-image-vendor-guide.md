# 第三方 App 对接：设备实时图片云端接口

更新于 2026-11-11。实时预览接口结构版本为 `0.16.0`，云端准入按 DEC-009@2.1.0 执行。

本包只交付云端接口说明、可导入 OpenAPI 和可校验样例。App 实现及真机验收由第三方自行负责，不是本包交付前置。本包不部署、不迁移目标库、不启用任何目标设备，也不证明设计域名已经部署本功能。

## 1. 给第三方的文件

| 文件 | 用途 |
|---|---|
| 本文 | 认证、接口参数、调用顺序、状态和错误处理 |
| [openapi.json](./fixtures/device-preview/openapi.json) | 可独立导入工具的 OpenAPI 3.1，仅包含两个设备接口，所有 `$ref` 已内置 |
| [frame-request.json](./fixtures/device-preview/frame-request.json) | 含完整 Base64 的 JPEG 请求，不是占位字符串 |
| [capture.jpg](./fixtures/device-preview/capture.jpg) | 对应 16×16、811 字节的可解码 JPEG |
| [responses.json](./fixtures/device-preview/responses.json) | IDLE/ACTIVE、接收/重放及各错误响应，共 21 份示例 |
| [manifest.json](./fixtures/device-preview/manifest.json) | 文件长度、SHA-256 与来源契约摘要，可核对交付内容和版本 |

机器契约的唯一事实源仍是仓库 [live-image-api.json](../../contracts/rest/live-image-api.json)，本包为自动生成的设备端子集，没有另立版本或增加接口。已有 [图片对接包](./device-image-device-package.md) 继续提供 Event/Alarm 的独立 S3 留档说明。

示例时间固定在 `2026-11-06T08:00:00.000Z`，**不能将示例帧原样提交到实际环境**。实际请求必须使用查询得到的当前 streamId、新采集的 UTC 时间、新 frameId 和对应 JPEG。导入文件的服务器为 `https://device-api.example.invalid`，有意使用不可用示例地址；调用前由云端负责人确认实际环境地址。

## 2. 两个设备接口与认证

设计域名为 `device-api.bio-nexa.com`。下表路径包含完整版本前缀，SDK 若 base URL 已含 `/api/v1`，不得再次拼接该前缀。实际可调用环境、证书配置及功能开启状态需按云端环境信息确认；本文没有发送任何目标请求。

| 方法 | 路径 | 成功 | 作用 |
|---|---|---|---|
| GET | `/api/v1/device/live-image/state` | 200 | 查询当前是否有人查看、当前 streamId 和可上传期限 |
| POST | `/api/v1/device/live-image/frames` | 200 | 上传一张当前预览 JPEG 的 Base64 |

- 使用既有设备 X.509 证书做 mTLS。设备身份由证书确定，不传 deviceId、customerId、viewerId 或 Authorization JWT；不伪造携带设备身份的 HTTP Header。
- 云端每次请求重新校验证书、设备归属、生命周期和运行状态。须已分配 Customer，生命周期和运行状态均为 Active 或 Maintenance。
- POST 使用 `Content-Type: application/json`；JSON 封闭对象，拒绝额外字段。
- 两接口响应为 `Cache-Control: no-store`。不要缓存或复用旧状态响应来恢复上传。
- TLS/网关错误可能在 JSON 业务响应之前发生，不保证所有错误都有 JSON 错误体。不得因 TLS 失败降级到 HTTP、关闭证书校验或改用平台 JWT。

### 能力启用和旧设备

设备支持 `live-image-v1` 后，由第三方通过本地软件或现场配置显式 opt-in，缺省关闭。未开启时不增加这两条调用，既有 MQTT、Sync 和归档流程继续使用。Configuration V1 不新增预览字段，cameraRefreshInterval 不覆盖下面的周期。

设备完成原有接入并满足上述条件后，即可用原设备证书查询状态，云端无需逐设备开通。无人查看返回 `200 IDLE`。只有授权用户在平台打开预览并持有有效租约时，设备才会收到 `ACTIVE` 和可用于上传的 `streamId`。

## 3. 查询查看状态

GET 无查询参数、无请求体。

无人查看：

```json
{
  "data": { "state": "IDLE", "pollIntervalMs": 5000 },
  "meta": { "requestId": "sample-device-preview", "timestamp": "2026-11-06T08:00:00.000Z" }
}
```

有有效查看租约：

```json
{
  "data": {
    "state": "ACTIVE",
    "pollIntervalMs": 5000,
    "streamId": "3874df1c-287c-43ee-9f18-6b25d26b9a08",
    "activeUntil": "2026-11-06T08:00:30.000Z",
    "uploadIntervalMs": 2000,
    "maxImageBytes": 131072
  },
  "meta": { "requestId": "sample-device-preview", "timestamp": "2026-11-06T08:00:00.000Z" }
}
```

上面的 UUID 仅演示结构；完整响应样例中的 UUID 与 frame-request.json 一致。真实 streamId 必须来自该设备的最新 ACTIVE 响应，不在设备上生成或持久化恢复。

ACTIVE 由平台页面打开预览并续租驱动：平台每 10 秒续 30 秒租约，每 2 秒读取画面。App 不操作平台 viewer 接口；平台无人查看时，持续查询到 IDLE 是正常结果。最后查看者释放后，云端会拒绝旧流上传，App 在收到失效结果或下一次状态查询时停止。首帧时间还包含查询、采集上传和平台读取，本包不额外承诺固定首帧 SLA。

| 字段 | 约定 |
|---|---|
| state | IDLE / ACTIVE；IDLE 没有 streamId 和 activeUntil，立即停止采样/上传 |
| pollIntervalMs | 固定 5000ms；开启能力后按此周期查询，最多一个状态查询在途，慢请求不叠加查询 |
| streamId | 云端生成的 UUID，所有有效查看页面共享。同设备从无租约到有租约会建立新流 |
| activeUntil | 该流有效租约中最晚截止。达到期限必须停止，不能靠上一张帧接收成功续期 |
| uploadIntervalMs | 固定 2000ms，采样和上传节拍；不是创建历史连拍队列的间隔 |
| maxImageBytes | JPEG 二进制上限 131072 字节，Base64 字符长度不是原图大小 |
| meta.timestamp | 服务器响应时间，供有效期计算；requestId 用于云端排查 |

设备应使用服务器时间差扣除完整请求耗时设置本地单调时钟期限，例如 `min(activeUntil - meta.timestamp, 30000ms) - RTT`；结果小于等于 0 时不启动上传。UTC 墙上时钟仍用于 capturedAt，不能为延长会话而改写服务器时间或采集时间。

每 5 秒新查询可更新当前流期限。状态/上传请求失败不延长已知期限；独立截止应在请求悬挂期间仍然有效。状态请求不能因为上传慢而被暂停，否则无法及时发现停止或流变化。

只有字段完整、UUID/时间有效且参数符合当前冻结契约的 ACTIVE 才能用于上传。未知 state、无效 JSON、错误成功状态或无法解析的期限均不作为开启采样的依据。

## 4. 上传 JPEG/Base64

请求字段（完整可发送的结构见 frame-request.json，文件里的测试时间须替换）：

| 字段 | 要求 |
|---|---|
| streamId | 当前 ACTIVE 返回的 UUID。旧流、IDLE 或期限已过时不发送 |
| frameId | 每张新采集 JPEG 的 UUID。同一个 HTTP 请求原样重试则沿用原值 |
| capturedAt | 真正采集时间，UTC ISO 8601，建议毫秒精度、Z 结尾；最多超前服务器 2 秒 |
| mimeType | 固定 image/jpeg |
| imageBase64 | JPEG 原字节的标准 Base64，含必要填充；无空白、无 data URI 前缀，不能使用 URL-safe Base64 |

默认长边 640px、保持纵横比；原图最多 128KiB，宽高各最多 1920px、总像素最多 2,073,600。云端做完整有界 JPEG 解码。整个 JSON 的 UTF-8 字节最多 180KiB（184320），包括字段名、引号、转义和空白。建议发送紧凑 JSON，先检查原图与最终请求两种长度。过大或损坏图片应重新调整采集，不能把任意字节加上 JPEG MIME 来绕过校验。

成功：

```json
{
  "data": {
    "frameId": "c674f6a1-9edc-47f0-8a48-2629a9e8c911",
    "receivedAt": "2026-11-06T08:00:00.400Z",
    "expiresAt": "2026-11-06T08:00:10.000Z",
    "replayed": false
  },
  "meta": { "requestId": "sample-device-preview", "timestamp": "2026-11-06T08:00:00.400Z" }
}
```

实际返回 frameId 应与请求一致；示例 UUID 仅说明结构。`expiresAt = min(capturedAt + 10s, receivedAt + 10s)`。`replayed=true` 是近期相同帧的幂等接收结果，仍返回原接收时间和原截止，不延长帧或租约。200 只表示该帧在服务器处理时被接收，不是后续继续上传的许可，也不表示页面已经显示。

### 并发与结果未知

1. 启动、重启或恢复网络后先 GET state，不恢复缓存 streamId，不补发历史预览图片。
2. ACTIVE 且期限有效时，按 2 秒采集。将采集、压缩和上传作为同一个忙标志覆盖的过程；上一帧未完成就跳过本次采样，最多保留这一张必要帧。
3. 状态变为 IDLE、streamId 变化或期限到达时，停止旧采样，取消/丢弃旧请求和回调；旧上传返回 200 也不能恢复旧流。
4. HTTP 超时/取消不是服务器回滚。网络栈未结束或未确认取消前不发第二个帧请求；继续跳过采样，不建立队列。恢复后先重新确认 state，再采新帧。
5. 若在同一有效流内重试同一个请求，streamId、frameId、capturedAt、JPEG/Base64 必须全部不变。不得复用旧 frameId 搭配重新拍摄的内容，也不得把旧图挂到新 streamId。预览默认丢弃失败旧帧、下一次发送新帧即可。

请求超时和退避预算由第三方网络库按运行条件配置，本包不增加冻结数值。无论选择何种预算，都不能越过 activeUntil 继续上传、叠加帧请求或因超时积压历史图片。

## 5. 错误及处理

JSON 错误体统一为 `{"error":{"code":"…","message":"The request failed","requestId":"…"}}`；message 不是可靠分支条件，按 HTTP 和 error.code 处理。完整正向错误响应在 responses.json。

| HTTP / code | 接口行为与第三方调用要求 |
|---|---|
| 400 VALIDATION_FAILED | 检查字段、UUID、UTC、Base64 与 JPEG；不得原样高频重试坏请求 |
| 401 UNAUTHENTICATED | 停止预览调用，检查设备证书/认证；按原设备认证恢复流程处理，不能换 JWT 绕过 |
| 403 FORBIDDEN | 设备挂起、退役、取消分配或归属异常时可能拒绝。立即停采、停帧；不得假设只是无人查看，不进入 2 秒重试循环 |
| 404 NOT_FOUND | 停止当前预览，由云端按 requestId 核查；不尝试更换 deviceId 访问其他设备 |
| 409 LIVE_STREAM_INACTIVE | 立即停止旧流，重新查询 state，只有新的有效 ACTIVE 才能采新帧 |
| 409 STALE_FRAME | 帧已过 10 秒有效期，或不晚于最近帧；丢弃旧帧，核查采集时钟/顺序，不改 capturedAt 后伪装重传 |
| 409 FRAME_CONFLICT | 同帧 ID 内容或申报改变；丢弃并修复 frameId/重试实现，不能原样重复冲突请求 |
| 413 PAYLOAD_TOO_LARGE | 调整 JPEG/JSON 大小，遵守 128KiB 与 180KiB 两个上限；网关提前拒绝时可能没有 JSON |
| 415 UNSUPPORTED_MEDIA_TYPE | 使用 application/json 请求及 image/jpeg 字段 |
| 429 RATE_LIMITED | 按 Retry-After 秒等待，停止采样且不积压；到期先确认 state，再采新帧。state 被限频时至少等待 max(5s, Retry-After)，不得借另一接口规避限频 |
| 503 TEMPORARILY_UNAVAILABLE / 断网 / 超时 | 停止当前帧，采用有上限退避；恢复时先查询 state。停止旧流和期限清理不等待重试结果 |

云端最多每秒接收一张新帧，正常设备周期仍为 2 秒。不要把最低限频阈值 1 秒当作新的采集配置。只记录 requestId、HTTP、错误码、耗时和字节数，避免记录 JPEG/Base64、证书私钥或签名 URL。

通用契约还定义 LIVE_VIEWER_EXPIRED（主要用于平台查看租约）。设备若收到该码或未识别的 409，同样停止旧会话并重新确认 state，不自行创建或续租平台 viewer。未知错误不能当作成功响应处理。

## 6. 与 Event/Alarm 留档独立

本预览只调用上面两个接口，不调用 media/upload-sessions、不 PUT S3、不发 MQTT media，因此不消耗归档上传会话配额，也不生成可长期查询的 MediaObject。

Event/ACTIVE Alarm 的图片继续走独立 JPEG → 原上传会话（triggerRef）→ S3 PUT → MQTT media，完整流程、不可变申报与签名头见 [设备图片对接包](./device-image-device-package.md#event-和-alarm-留档调用顺序)。告警/事件消息优先上报，不能为了等待预览帧或归档上传阻塞原业务消息。原图留档不是从平台的临时最新帧反向补取。

## 7. 调用模板与云端本地校验

以下是给第三方的模板，本批没有执行请求。占位文件为第三方自己的设备证书，不提供或生成凭据：

```bash
curl --cert /path/to/device-client.crt --key /path/to/device-client.key \
  --cacert /path/to/trusted-server-ca.pem \
  'https://device-api.example.invalid/api/v1/device/live-image/state'

curl --cert /path/to/device-client.crt --key /path/to/device-client.key \
  --cacert /path/to/trusted-server-ca.pem \
  -H 'Content-Type: application/json' --data-binary @frame-request.json \
  'https://device-api.example.invalid/api/v1/device/live-image/frames'
```

实际部署须使用可信服务端证书链；不得添加 `-k`。第二条命令执行前务必生成新采集时间、frameId 并填入当前 streamId，示例 JPEG 仅用于离线检查。

云平台仓库中可执行以下离线检查，不需要 App、设备或云凭据：

```bash
node scripts/generate-device-preview-handoff.mjs --check
node --import tsx --test scripts/device-preview-handoff.test.mjs
pnpm exec redocly lint docs/api/fixtures/device-preview/openapi.json --extends spec
```

检查覆盖 OpenAPI 独立可解析、与冻结两路由语义一致、21 份响应符合各 HTTP Schema、完整 JPEG/Base64 一致、错误请求负例、文件 Hash 和导出新鲜度。这些检查只证明云端接口包可交付，不替代部署状态。App 编码、相机调试及真机验收不属于本次交付范围。
