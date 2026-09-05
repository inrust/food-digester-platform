# BE-MED-01 Media 上传会话与元数据 API

实现：[apps/cloud-api/src/media](../apps/cloud-api/src/media)（errors/storage/service/device-handler/admin-handler）；REST 契约 [device-media-api.json](../contracts/rest/device-media-api.json) + [admin-media-api.json](../contracts/rest/admin-media-api.json)；上传策略扩展点 [contracts/media/media-upload-policy.json](../contracts/media/media-upload-policy.json)；验收测试 [media.test.ts](../apps/cloud-api/test/media.test.ts)（9 项，PGlite）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-MED-01（P2 / 设备及管理接口），依赖 AUTH-03（mTLS 设备认证）、AUTH-01（media:read 权限矩阵）、IAC-01（Media Bucket）、DEC-005（RDS 元数据 + S3 文件，已冻结）、DEC-009（无实时流媒体，已冻结） |
| 事实源 | 实施方案 §11.9（上传会话 → 预签名 URL → 元数据上报 → Object/大小/Hash 校验 → 短期下载 URL）；CT-03 media.schema.json（元数据字段） |
| Schema 变更 | `media_upload_sessions` 新增 `declared_sha256`（设备会话申报 Hash，供上传后比对；[migration 20260905120000](../packages/database/prisma/migrations/20260905120000_media_upload_session_sha256/migration.sql)，可空列、无回填） |
| 功能边界 | 不采集/转码媒体；保留期处置属 DEC-005/BE-ARC-02（本任务不实现到期删除）；不提供 RTSP/WebRTC/HLS 实时流媒体会话（DEC-009） |

## 2. 关键设计

**设备端上传会话**（`POST /api/v1/device/media/upload-sessions`，mTLS）：AUTH-03 证书白名单 → 生命周期 Active/Maintenance + 已分配 Customer → 策略校验（mediaType 枚举、fileName 安全字符、sizeKb 类型上限 IMAGE 10MiB/VIDEO 200MiB、sha256 hex64）→ 每设备每日配额（100，UTC 自然日）→ 服务端生成 `media/{customerId}/{deviceId}/{sessionId}/{fileName}` objectPath + 15 分钟预签名上传 URL（均为 [media-upload-policy](../contracts/media/media-upload-policy.ts) 暂定值，经策略门面注入，不复制数值）。

**元数据校验**（`handleMediaMetadata`，MQTT media 上行消费者）：幂等键 sourceMessageId=meta.id → objectPath 逐字符等于已签发会话 Key（跨设备/跨会话/任意 Key 拒绝）→ 申报一致性（fileName/mediaType/sizeKb）→ Object 存在 → 大小匹配（ceil KB）→ SHA-256 重算比对会话申报值 → MediaObject AVAILABLE + 会话 COMPLETED（同事务 + 审计）；所有拒绝无写入。

**管理端**（`GET /api/v1/admin/media`、`GET /{mediaId}/download-url`，media:read）：Customer 角色强制租户隔离（跨 Customer 列表空集/详情下载 404；customerId 参数与身份不一致 → 403）；DELETED（DEC-005 文件到期删除、元数据保留）不提供下载；下载 URL 15 分钟（暂定值 900s）。

**审计（DOM-03）**：`media.upload_session.create` / `media.object.register` 经 `audited` 写入。

## 3. 验收基准与证据（vitest + PGlite，9 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 跨设备 Key 拒绝 | 设备 B 冒用设备 A 会话 Key → FORBIDDEN_PATH；他人前缀/非模板 Key → FORBIDDEN_PATH；本设备前缀但未签发会话 → UNKNOWN_SESSION；均无写入 | ✅ |
| 超限文件拒绝 | IMAGE 10241KB / VIDEO 204801KB → 400；每设备每日配额超限 → 409 | ✅ |
| 不存在 Object 拒绝 | OBJECT_MISSING（拒绝后无写入，会话保持 ISSUED） | ✅ |
| Hash 不符拒绝 | 重算 SHA-256 与会话申报不符 → HASH_MISMATCH；大小不符 → SIZE_MISMATCH；申报不一致 → METADATA_MISMATCH | ✅ |
| 下载遵守 Customer 权限 | 跨 Customer 下载 → 404；Customer 列表强制 scope、越权筛选 → 403；DELETED → 404（元数据保留可见）；URL 900s | ✅ |
| 设备认证 | 无/未知证书 → 401；Suspended/Retired/未分配 Customer → 403；Maintenance 放行 | ✅ |
| 幂等与审计 | sourceMessageId 重放不重复写入；会话完成/对象注册审计齐备 | ✅ |

## 4. 未决风险

- **上传限制为暂定值**（media-upload-policy provisional，无登记决策）：大小上限/日配额/TTL 冻结前可执行，冻结时需登记决策并提升策略版本；消费方均经策略门面注入。
- **S3 adapter 为端口定义**：HeadObject/流式 SHA-256/presigned PUT/GET 的 AWS 实现由部署层接线（IAC-01 Media Bucket + `MEDIA_BUCKET_NAME` 已备）；Media 元数据 MQTT 上行 Ingress（IoT Rule → Lambda 调 `handleMediaMetadata`）同属部署层。
- **会话 EXPIRED 清扫**：超时未完成的 ISSUED 会话标记 EXPIRED 的清扫器未实现（当前 EXPIRED 会话元数据拒绝 SESSION_NOT_OPEN）；如需 sweeper 另立任务。
- **sizeKb 申报口径**：按 ceil(bytes/1024) 严格比对；设备端须按同一口径申报（已写入契约描述）。
