# 第三方对接：Event / Alarm 图片留档云端接口

2026-11-07；云平台参考提交 `981ec939`，冻结契约 `0.16.0`、DEC-024@1.0.0。本包交付云端接口、S3 上传约束与 MQTT 样例；App 实现、持久队列和真机验收由第三方负责，不作为本批前置。本批未部署、未迁移目标库、未启用设备或访问真实 S3。

## 1. 文件与唯一事实源

| 文件 | 用途 |
|---|---|
| [openapi.json](./fixtures/device-archive/openapi.json) | 单独可导入的上传会话 OpenAPI，保留原 IMAGE/VIDEO 兼容与 triggerRef 条件，无外部引用 |
| [event-upload-request.json](./fixtures/device-archive/event-upload-request.json)、[alarm-upload-request.json](./fixtures/device-archive/alarm-upload-request.json) | 基于真实样例字节的两类不可变申报 |
| [legacy-upload-request.json](./fixtures/device-archive/legacy-upload-request.json) | 无 triggerRef 的旧请求兼容样例 |
| [responses.json](./fixtures/device-archive/responses.json) | 15 份 HTTP 响应：首次签发、有效重用、过期新办、已登记、冲突及普通错误 |
| [event-mqtt.json](./fixtures/device-archive/event-mqtt.json)、[alarm-mqtt.json](./fixtures/device-archive/alarm-mqtt.json) | 原触发消息、media 登记、过期新会话后的新 media；Alarm 另含 CLEARED 消息 |
| [mqtt-schemas.json](./fixtures/device-archive/mqtt-schemas.json) | 原 common/event/alarm/media Schema 的逐字内容，支持离线校验 |
| [s3-put-examples.json](./fixtures/device-archive/s3-put-examples.json) | checksum 在 query 或签名 Header 的两种 PUT 结构示意 |
| [capture.jpg](./fixtures/device-archive/capture.jpg)、[manifest.json](./fixtures/device-archive/manifest.json) | 811 字节、16×16 JPEG；精确字节、ceil KB、SHA-256 hex / Base64、源文件与导出摘要 |

事实源是 [device-media-api.json](../../contracts/rest/device-media-api.json)、[MQTT Schema](../../contracts/mqtt/schemas/media.schema.json)、[媒体上传策略](../../contracts/media/media-upload-policy.json) 和[实际签名器](../../packages/aws-clients/src/s3-media-url-signer.ts)。本包不新增登记接口、receipt 查询接口或业务确认 Topic，不改变原 MQTT 字段。

全部时间固定为 `2026-11-06T08:00:00.000Z` 附近，设备名、消息 ID、序号、对象路径均为独立分支示例，不能按文件排列拼接发布，也不能直接用于目标环境。示例域名 `.invalid`、Credential 和 Signature 都不可用；S3 示例只是签名头/校验和结构，不是可执行签名或真实凭据。实际上传必须使用云端返回的完整 URL 和 objectPath。

## 2. 一条 Event / ACTIVE Alarm 的顺序

1. 原 Event 或 ACTIVE Alarm 有独立 MQTT meta.id/ts/seq，并优先上报原业务消息。为该触发准备 JPEG；不能用等候图片上传代替原告警上报。
2. 对同一份原始 JPEG 得到 sizeBytes、ceil(sizeBytes/1024)、SHA-256 hex，申请上传会话并携带 triggerRef。
3. 根据 HTTP 结果区分首次 201、重用 200、过期新办 201 或已登记 409。保留首次申报，不能为重试重新拍摄或改名。
4. 对返回 URL 用普通 HTTPS PUT 原 JPEG 二进制。不是 Base64 JSON，不走 MQTT 图片体，也不是设备 REST mTLS 的请求体。
5. S3 成功后，在会话有效期内向自身 `bnx/device/{deviceId}/media` 发布元数据。objectPath 逐字符使用对应会话值。
6. PUBACK 只确认 Broker 接收。用**同一申报 POST 同一个上传会话接口**确认，只有 `409 MEDIA_ALREADY_REGISTERED` 且含 mediaId 才确认图片业务登记已完成。
7. 已登记后的 Event/Alarm 关联由云端异步完成，不影响第三方结束该图片的上传任务；登记确认不等于关联成功。

该归档链路与[实时预览接口](./device-live-image-vendor-guide.md)独立。不要求存在 live stream，不受实时帧 128KiB/10 秒约束，不把临时预览帧当作原事件照片。预览不调用归档上传会话，不占其配额；归档新签发才计归档配额。

## 3. 申请与重复确认：同一个 POST

`POST /api/v1/device/media/upload-sessions`，`Content-Type: application/json`。设计设备域名为 `device-api.bio-nexa.com`，实际环境由云端另行确认。使用既有设备 X.509 mTLS，身份来自证书，不传 customerId/deviceId/objectPath/Bucket 或平台 JWT。设备已分配 Customer、生命周期 Active/Maintenance；撤证、挂起、退役或归属变化会重新校验。

```json
{
  "mediaType": "IMAGE",
  "fileName": "capture.jpg",
  "sizeKb": 1,
  "sizeBytes": 811,
  "sha256": "7dfd14be2099179bf3b0dd16e40e36444112a4cd581edf2c03b497aeeb950484",
  "triggerRef": { "kind": "ALARM", "messageId": "ALM-DEV001-184" }
}
```

| 字段 | 要求 |
|---|---|
| mediaType | triggerRef 只允许 IMAGE；通用旧接口仍接受既有 IMAGE/VIDEO 请求 |
| fileName | 1～128 字符，仅 `[A-Za-z0-9._-]`，不含路径分隔符；首次申报后逐字符不变 |
| sizeBytes | 正安全整数，原 JPEG 的精确字节数；不能用 Base64 字符数或舍入 KB 代替 |
| sizeKb | 正整数，必须等于 ceil(sizeBytes/1024)，IMAGE 最大 10240KB（10MiB） |
| sha256 | 同一原 JPEG 的 64 位 hex；云端按小写规范化比较，大小写差异不算内容改变 |
| triggerRef.kind | EVENT / ALARM，只含 kind/messageId，不接受 null、数组或额外字段 |
| triggerRef.messageId | 原触发消息的 meta.id，不是 media 消息 ID；1～128 ASCII 字符，匹配 `^[A-Za-z0-9][A-Za-z0-9-]{0,127}$`，逐字符区分大小写 |

唯一触发键是当前 Customer + 当前 deviceId + kind + messageId。设备与客户由认证/台账取得，不能靠请求选择。相同 code/相近时间的两次告警是不同消息，不能混用图片；消息 ID 也不能为逃避冲突或额度而任意换新。

ALARM 引用 ACTIVE 消息（示例 184）。后续 CLEARED 使用自己的新消息 ID/序号（示例 186），不申请新图覆盖原关联，不把 triggerRef 改为清除消息。清除发生在关联之前或之后，都允许原 ACTIVE 图片继续关联/读取。

示例 eventType/code 不构成拍照业务白名单。第三方按既有业务规则选取触发，云端按原消息精确关联，本包不为满足样例新增事件或告警类型。

归档样例使用 JPEG；云端登记核对对象、精确长度和 Hash，不应把实时预览的 Base64/JPEG 解码错误码直接套用到归档接口。

### 响应与不可变申报

| 条件 | 返回与处理 |
|---|---|
| 首次引用、合法申报、额度充足 | 201，新的 sessionId/objectPath、签名 URL、createdAt 和 uploadUrlExpiresAt |
| 同引用同申报、ISSUED 仍有效 | 200，原 sessionId/objectPath/createdAt/截止不变；URL 可重签变化，不重新计额度 |
| 同引用但合法申报的文件名、类型、字节数、KB 或 Hash 改变 | 409 MEDIA_TRIGGER_CONFLICT；不得当成已登记，不提供原 mediaId |
| 同申报且已经存在登记 MediaObject | 409 MEDIA_ALREADY_REGISTERED，含 details.mediaId；不签 URL，不计额度。图片已软删除也不会为同一触发重新签发 |
| 未登记且会话已过期 | 可 201 新办，同一 triggerRef/原 JPEG/申报，新的 sessionId/objectPath 和新额度；不能继续把旧路径用于新尝试 |
| UTC 自然日新签发额度用尽 | 409 CONFLICT；不是预览的 429 RATE_LIMITED。有效重用及已登记判定优先于新额度检查 |
| 省略 triggerRef 的旧请求 | 按旧流程每次新办 201，不获得按触发引用重用/查询登记语义；旧媒体仍兼容 |

每台设备每 UTC 自然日最多 **100 个新上传会话**，初次及到期新办各计一次；有效重用和已登记确认不计新额度。失败、过期不自动返还额度。触发申报冲突检查先于已登记返回，改变申报不会取到原 mediaId。

201/200 都返回 `data + meta`，data 包括 sessionId、mediaType、fileName、sizeKb、sizeBytes、objectPath、uploadUrl、uploadUrlExpiresAt、createdAt，以及新请求的 triggerRef 回显。详见 responses.json 的 `alarm-created`、`alarm-reused`、`alarm-expired-new` 和 EVENT 对应条目。

样例初次 08:00 签发、08:15 到期；08:05 重用仍是 08:15，到期前只重签剩余秒数；08:16 新办到期为 08:31，旧路径不再有效。不要自行按“响应接收时间 + 900 秒”推算重用期限，实际签名也可能因向下取整或临时凭据更早失效。

## 4. S3 PUT 与签名 Header

| 项目 | 约定 |
|---|---|
| 方法与 body | PUT，capture.jpg 原二进制字节，不进行 Base64 编码、不重压缩、不 multipart |
| URL / Host / Query | 完整使用响应 URL，不更换 Bucket、Key、主机，不丢弃/重建查询项，包括可能的安全 token 和 checksum |
| Content-Length | 最终 HTTP 报文为精确 sizeBytes，本例 811。使用网络库固定长度上传，避免自动 chunked 改变请求语义 |
| x-amz-checksum-sha256 | SHA-256 原始 32 字节的标准 Base64，本例 `ff0UviCZF5vzsN0W5A42REESpM1YHt8sA7SXruuVBIQ=`；不是 hex 文本再 Base64，也不是 ETag |
| X-Amz-SignedHeaders | 以实际 URL 列表为准，所有被签 Header 须发送精确值。Host 由 HTTP 客户端取 URL |
| checksum 在 query | 若完整 URL 已有 `x-amz-checksum-sha256`，保留原值；按 SignedHeaders 发送长度等 Header，不自行删去或改写 query |
| checksum 在 Header | 若 SignedHeaders 包含 `x-amz-checksum-sha256`，必须发送同值 Header；示例提供两种结构，不能把它们视为两个上传接口 |
| Content-Type | 本 JPEG 可用 image/jpeg；当前签名器未绑定该项。若返回 URL 将来签入它，则发送约定的精确值 |
| 身份隔离 | S3 使用签名 URL 授权，不附加平台 JWT、设备 REST Authorization、自定义证书身份 Header，也不需要设备 mTLS 客户端证书；仍校验普通 HTTPS 服务端证书 |

当前实际签名器 `PutObjectCommand` 绑定 ContentLength 和 ChecksumSHA256；checksum 落在 query 还是 Header 由 SDK 签名结果决定。因此不能硬编码固定的 SignedHeaders 字符串。对应结构见 s3-put-examples.json；两份 URL 明确包含不可用 Signature 标记，不能执行。

S3 PUT 2xx 仅说明对象上传步骤成功，不是业务登记。ETag 不等于本业务 SHA-256。上传中超时意味着结果未知；在仍有效会话内可重签并原样重传相同字节，不能改 JPEG 继续使用旧 Hash。URL 失效时仍通过同一原申报申请会话，由服务端判定重用还是到期新办；设备没有单独的 S3 HEAD/GET 设备授权接口。

## 5. MQTT 原触发与 media

使用既有设备 MQTT 证书与自身 Topic，QoS 1。完整消息见 event-mqtt.json / alarm-mqtt.json。

```json
{
  "meta": { "id": "MED-DEV001-907", "ts": "2026-11-06T08:00:02.000Z", "seq": 907 },
  "data": {
    "mediaType": "IMAGE",
    "captureTime": "2026-11-06T08:00:00.000Z",
    "fileName": "capture.jpg",
    "objectPath": "media/CUS001/DEV001/ALARM-SESSION-001/capture.jpg",
    "sizeKb": 1,
    "durationSec": 0
  }
}
```

MQTT media **不增加 triggerRef、sessionId、sizeBytes、sha256 或图片体**；triggerRef 绑定在 REST 上传会话，云端按 objectPath 定位该会话。字段使用会话回显值，captureTime 保持原采集时刻。云端核对对象存在、精确字节/Hash、申报和当前权限后，事务提交 MediaObject、PENDING Evidence、会话完成、receipt 和 Outbox。

有效期由云端消费/提交时的当前时间判断，不能仅凭 S3 成功或 MQTT 发送早于截止，就认为最终登记必定成功。临近到期结果未知时仍用原申报确认；若云端新办了会话，应使用新路径重新上传并发布新的 media，不把旧 objectPath 当成新会话的路径。

- media.meta.id 是新的媒体消息 ID，不能使用原 Event/Alarm 的 ID。seq 按每设备每上行类型单调递增，独立于原 event/alarm 序号空间。
- 同条消息的网络重传保持 meta.id、ts、seq、data 全部不变。不能因 DUP 或重连改内容，不能改旧 ts 后复用旧 seq。
- 云端默认时间偏差窗口为 300 秒，目标配置为准。历史补传没有另开 API。超过窗口的原消息不能靠改时间绕过校验。
- 过期新办后，使用**新 objectPath、新 media ID/seq/ts** 发布新的 media，保留原 captureTime 和 triggerRef；旧会话/旧新消息竞争由云端事务保证最多一张有效触发图。
- 原触发消息若一直未成功处理，不允许编造新的触发引用“补齐”。它可能最终 UNMATCHED，需按云端错误/关联结果处理。

## 6. 登记确认样例：不是 PUBACK

不订阅新的业务 ACK Topic，不虚构 GET status/receipt 接口。S3 上传和 MQTT 发布后，用原 `alarm-upload-request.json` 再 POST **同一个** `/api/v1/device/media/upload-sessions`。

```json
{
  "error": {
    "code": "MEDIA_ALREADY_REGISTERED",
    "message": "The trigger image is already registered",
    "requestId": "sample-registered",
    "details": { "mediaId": "ALARM-MEDIA-001" }
  }
}
```

HTTP 必须是 **409**，且按 code/details 判断；这是预期的完成分支，不能被通用“所有非 2xx 都是上传失败”逻辑覆盖。EVENT 样例为 `event-registered`，返回自己的 mediaId。

| 已观察结果 | 能确认什么 | 不能据此确认什么 |
|---|---|---|
| S3 2xx | 对象上传步骤成功 | Media 登记、原触发处理或图片关联成功 |
| MQTT PUBACK | Broker 收到消息 | Schema/时间校验、receipt/数据库提交成功 |
| 重复申请 200 | 同一申报会话仍有效，可继续流程 | MQTT 失败、已登记、需要重拍或重新计额度 |
| 409 MEDIA_ALREADY_REGISTERED + mediaId | 该触发图片的 Media 登记事实存在，结束本次上传任务 | 原 Event/Alarm 已处理、Evidence 已 LINKED、图片尚未因保留策略删除 |

重复确认采用退避，不用实时预览的 2 秒抓拍频率不断创建新任务；不能为了确认而改变申报。签名依赖故障可能在会话已提交后返回 500，同申报再次申请可返回 200，不要据此重新拍图或制造新 triggerRef。

## 7. 关联与错误边界

图片登记后的 Evidence 为 PENDING，按当前 Customer、同 deviceId、kind 和原 sourceMessageId 精确匹配。Outbox 触发首轮解析，PENDING 每分钟有界重试；匹配后转 LINKED，登记后最多等待 24 小时，未匹配到期转 UNMATCHED。云端不会按 code/相近时间猜图。

设备的登记完成确认不暴露内部 Evidence/Outbox/receipt 行。平台有源记录读取及 media:read 权限时，通过既有告警详情/事件查询看到 evidenceImage：未匹配为 null、已关联为 AVAILABLE、保留策略删除为 DELETED；无媒体读取权限省略字段。告警清除仍保留原关联。无需给第三方设备 App 平台 JWT。

| HTTP / code | 处理 |
|---|---|
| 400 VALIDATION_FAILED | 修正结构/类型/字节/Hash/安全文件名；不原样循环发坏请求。归档上限不是预览的 413 错误分支 |
| 401 UNAUTHENTICATED | 检查既有设备证书流程，不绕过认证或换平台 JWT |
| 403 FORBIDDEN | 设备状态、归属或权限拒绝，停止该授权上下文下上传，不通过换 deviceId/key 重试 |
| 409 MEDIA_TRIGGER_CONFLICT | 触发申报改变，排查不变性；不能误当 MEDIA_ALREADY_REGISTERED |
| 409 MEDIA_ALREADY_REGISTERED | 按上节完成分支；details.mediaId 只在该分支提供 |
| 409 CONFLICT | 新签发额度等冲突；不承诺用重试退回旧额度，按 UTC 配额恢复 |
| 500 INTERNAL_ERROR | 结果可能未知，保留原申报退避再确认。不是已登记或“可以改文件重新上传” |

TLS/网关拒绝可能不是业务 JSON；S3 错误也不使用上述 REST 错误包络。记录 requestId、HTTP/错误码、消息 ID、阶段和字节数即可，不记录签名 URL、设备私钥或原图内容。

## 8. 离线校验

```bash
node scripts/generate-device-archive-handoff.mjs --check
node --import tsx --test scripts/device-archive-handoff.test.mjs scripts/device-preview-handoff.test.mjs
pnpm exec redocly lint docs/api/fixtures/device-archive/openapi.json --extends spec
```

检查覆盖冻结 REST 语义/认证、条件 IMAGE 及旧请求、15 份 HTTP 响应、MQTT 原触发与登记/替换/清除消息、同路径和引用、二进制/Checksum/签名头、重用不延长/到期换 Key、Hash 与导出新鲜度。S3 示例不是有效签名，真正签名器的离线 SDK 测试另行运行；两者都不证明真实 S3 已接受请求。App 实现与真机验收不在本包交付范围。
