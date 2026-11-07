# 设备图片功能对接包

契约版本 0.16.0，DEC-009@2.0.0。五个预览接口和 triggerRef 扩展在 P0 定义，运行接线按 IMG-05 至 IMG-13 交付。完整机器契约见 [实时预览 OpenAPI](../../contracts/rest/live-image-api.json)、[上传会话](../../contracts/rest/device-media-api.json) 和 [生成类型](../../contracts/rest/image-types.ts)。

2026-11-07 职责澄清：本仓库只负责云端对接包交付，第三方负责 App 实现；App 源码与真机验收不作为本包交付前置。实时预览的完整第三方说明、独立 OpenAPI 和可校验请求响应见 [第三方 App 云端接口包](./device-live-image-vendor-guide.md)。

## 能力启用与设备调用顺序

设备本地增加可选 liveImage 配置，缺省 disabled。支持 live-image-v1 的 App 由第三方软件发布或现场配置显式开启。云端按原始 deviceId 的 DeviceLiveImagePolicy.enabled 白名单记录准入，缺行/false 均关闭（IMG-08 实现，不由 App 写入）。设备本地与服务端均开启后才能预览。未启用设备继续使用原接口，不新增轮询。Configuration V1 的四个字段不增加预览字段，cameraRefreshInterval 不用于覆盖新的 2 秒周期。

1. 按原流程连接、首次 Heartbeat 和 Sync，取得可信设备身份及归属。使用原设备 mTLS 证书调用 Device REST。
2. 启用设备每 5 秒调用 GET /api/v1/device/live-image/state，无人查看时 IDLE。有租约时 ACTIVE 带 streamId、activeUntil、uploadIntervalMs 和 maxImageBytes。
3. 每 2 秒抓 JPEG，以新的 frameId、UTC capturedAt 和无前缀 Base64 POST /api/v1/device/live-image/frames。上次仍在发送时跳过本次采集。沿用同一个请求重试时不修改任何字段，旧流请求丢弃。
4. 租约到期、状态 IDLE、403 或 LIVE_STREAM_INACTIVE 时停止传图。断网恢复后先查状态，再拍新帧。请求超过 180 KiB、原图超过 128 KiB 或 JPEG 尺寸超限须先调整采集规格。
5. 平台以 JWT PUT 查看租约，每 10 秒续 30 秒，GET latest 每 2 秒一次并带本页 viewerId。最多 16 个查看者，后台页签停止续租，离开时 DELETE 自身租约。前端本地定时清除到期帧，旧会话迟到响应丢弃。

## 可校验样例

[样例目录](../../contracts/rest/fixtures/device-images) 包含可解码的 16×16 JPEG、对应 Base64 请求、文件长度和 SHA-256 manifest、旧上传请求、Alarm/Event 上传请求、会话响应，以及请求响应正负向用例。样例使用固定测试时钟，实际发送时更新 streamId、frameId 和时间。目录中的 example.invalid URL 只用于校验数据结构，实际上传须使用云端真实响应。

```bash
node --import tsx --test contracts/rest/device-image-api.test.ts
sips -g pixelWidth -g pixelHeight contracts/rest/fixtures/device-images/capture.jpg
node scripts/generate-image-contract-types.mjs --check
```

样例校验验证 Base64 解码后的字节逐一一致、SHA-256、精确长度和 ceil KB，JPEG 解码尺寸由 sips 本地核对。JPEG 内容检查、捕获时间窗和业务权限由后续服务实现，不能仅依赖 Schema。

## Event 和 Alarm 留档调用顺序

1. 本地 Event 或 ACTIVE Alarm 首先生成并持久保存 meta.id 和原始 MQTT 报文，抓拍独立 JPEG，先发送业务消息。
2. 对 JPEG 计算 sizeBytes、ceil(sizeBytes/1024) 和 SHA-256 hex，POST 原 media/upload-sessions，新增 triggerRef.kind 与原始 meta.id。ALARM 引用激活消息，EVENT 引用事件消息。
3. 201 表示新会话，200 表示复用原有效会话。按返回的预签名 URL PUT 原 JPEG，再发布原有格式 MQTT media，objectPath 逐字符采用响应值。
4. 通过同一申报重试查询登记结果。MEDIA_ALREADY_REGISTERED 的 details.mediaId 表示已登记，可以移除本地上传任务。MEDIA_TRIGGER_CONFLICT 表示同一触发引用文件内容或申报发生变化，须排查本地持久队列。会话过期重办使用原 JPEG 和 triggerRef，新路径与新 MQTT media 消息。
5. 图片与原事件可乱序入库，由服务端 PENDING 关联任务处理。PUBACK 用于 Broker 接收确认，媒体入库需用登记结果确认。历史消息重发遵循原 MQTT 时间窗，过期触发消息不能通过改时间复用序号。

## S3 签名和 Header

REST 申请上传会话需要设备 mTLS。S3 PUT 使用返回的完整预签名 HTTPS URL，由 URL 授权，只上传原 JPEG 字节。禁止将 JWT 或设备 REST Authorization 信息加到 S3 请求。

| 项目 | 设备要求 |
|---|---|
| HTTP method 和 body | PUT，原二进制 JPEG。上传后的对象字节必须与申请会话时计算 Hash 的字节一致 |
| Content-Length | 精确 sizeBytes，固定长度上传，避免 SDK 自动改为 chunked |
| Host | 由完整 URL 确定，不能修改主机或重建查询参数 |
| x-amz-checksum-sha256 | SHA-256 原始 32 字节的标准 Base64，见 manifest。签名器可能把它放到 URL 查询参数。若已包含，完整保留；若在 X-Amz-SignedHeaders 中则按要求发送同值 Header |
| X-Amz-SignedHeaders | 按返回 URL 列表逐项满足签名 Header。当前签名器绑定 ContentLength 与 ChecksumSHA256，未绑定 ContentType；不要自行推断其他固定签名 Header |
| Content-Type | 可发 image/jpeg，若将来签名器签入该项，须使用响应约定的精确值 |
| 成功判定 | S3 2xx 后才发 media 元数据；仍须等待云端登记校验。文件过期或 URL 失效按会话流程重办 |

[当前签名器](../../packages/aws-clients/src/s3-media-url-signer.ts) 的签名头和查询参数处理需在真实 S3 验收，当前状态 NOT_RUN。预签名 URL 的示例字符串不含可用凭据。

## 外部实施与后续环境参数（不作为本云端包交付前置）

| 输入 | 负责人 | 需要时点 |
|---|---|---|
| 拍照 Event 类型和 Alarm code 白名单，至少各一类及可触发步骤 | 设备方和业务方 | IMG-18 与真机用例冻结前 |
| 支持软件版本、设备本地开启配置、默认压缩质量与性能 | 第三方 App 开发方 | 第三方实现自行管理 |
| 预计启用数、同时查看数、实际图片大小分布 | 运营与设备方 | 共享存储负载评估和 IMG-23 前 |
| 首帧可接受等待目标与网络条件 | 业务方和设备方 | IMG-22 验收前 |
| 隔离设备 ID、归属、证书、平台角色和测试窗口 | 环境负责人 | IMG-21 前 |

上述参数保留为外部实施背景；不要求提供 App 仓库，也不阻塞本仓库云端接口包交付。目标环境调用未在本批执行，App 实现与真机验收由第三方自行负责。
