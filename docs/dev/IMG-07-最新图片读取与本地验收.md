# IMG-07 最新图片读取与本地验收

2026-11-06，基于本地提交 4d5e3479 完成最新帧读取服务、框架无关 Handler，以及 CONTROL 与 FRAME 的事务快照端口。本地模块验收为 PASS，G1 继续为 PARTIAL。初始 main 工作区干净，已有三个未推送提交，本批按用户要求只创建本地提交。

实施依据为 [接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、[P0 并发设计](./IMG-03-图片预览临时存储与并发设计.md) 和 [帧上传实现](./IMG-06-图片帧上传与本地验收.md)。

## 修改文件和职责

| 文件 | 实现 |
|---|---|
| [latest-service.ts](../../apps/cloud-api/src/live-image/latest-service.ts) | LiveImageLatestService，按当前授权和事务快照返回 READY、UNCHANGED、WAITING_FRAME |
| [storage.ts](../../apps/cloud-api/src/live-image/storage.ts) | 只读 LiveImageLatestStore 与 LiveImageLatestSnapshot，要求同一次事务读取 CONTROL/FRAME |
| [handler.ts](../../apps/cloud-api/src/live-image/handler.ts) | createLiveImageLatestHandler，校验 actor、路径、查询和请求体，复用 no-store、data/meta 及错误脱敏封装 |
| [service.ts](../../apps/cloud-api/src/live-image/service.ts) | 复用查看者准入和 UUID 规范化，补 LIVE_VIEWER_EXPIRED 错误码 |
| [index.ts](../../apps/cloud-api/src/live-image/index.ts) | 导出读取服务、Handler 和只读存储端口 |
| [live-image-fixtures.ts](../../apps/cloud-api/test/live-image-fixtures.ts) | 扩展共享测试存储的事务快照和前后并发控制点 |
| [live-image-latest.test.ts](../../apps/cloud-api/test/live-image-latest.test.ts) | 44 项状态、权限、租约、事务快照和授权失效专项用例 |

新读取接口在 OpenAPI 中继续为 planned，生产路由和共享存储适配按 IMG-08 接入。

## 请求和返回规则

GET latest 的 viewerId 必填，knownFrameId 可选，均按 UUID 校验并规范化大小写。body 按既有无请求体接口规则拒绝。actor 从认证上下文注入，查询参数中的 Customer 信息不能改变授权范围。

每次读取先在鉴权共享锁内刷新当前用户身份、角色及设备可见范围，再检查 media:read、Customer 分配、能力开关、生命周期和运行状态。CONTROL/FRAME 由只读端口以同一事务快照返回，查询不会续租、更新水位或触碰物理 TTL。

CONTROL 的 deviceId、customerId、enabled 必须匹配当前准入上下文。请求用户自己的 actorId/viewerId 租约必须存在，截止时间有限且晚于快照读取完成后的当前时间，streamId 必须有效。其他页面或其他用户的租约不能替代该页租约。

| 条件 | 响应 |
|---|---|
| 缺身份、身份已撤销 | 401 UNAUTHENTICATED |
| 设备不可见或跨 Customer | 404 NOT_FOUND |
| 缺 media:read、能力关闭、设备状态不允许、CONTROL 已封闭或归属不符 | 403 FORBIDDEN |
| CONTROL、当前查看者租约或当前 streamId 缺失，或者本页租约过期 | 409 LIVE_VIEWER_EXPIRED |
| 租约有效，但缺帧、帧过期，或帧 device/customer/epoch/stream/MIME/采集水位不匹配 | 200 WAITING_FRAME，仅带当前 streamId |
| 帧有效且 knownFrameId 匹配 | 200 UNCHANGED，带 frameId 和原截止，省略图像及采集时间 |
| 帧有效且客户端尚未知该帧 | 200 READY，带 JPEG Base64、采集时间及截止 |
| 存储或鉴权依赖未知异常 | 503 TEMPORARILY_UNAVAILABLE，固定安全错误文本 |

帧的有效截止取已存 expiresAt、capturedAt 加 10 秒及 receivedAt 加 10 秒的较早值。未通过有效期和授权校验时，即使命中 knownFrameId，也不能返回 UNCHANGED。无效日期会被判定为不可见，物理保留的旧帧进入 WAITING_FRAME。返回通过显式字段清单构造，排除内部 Customer、epoch、revision 和 TTL。

## 并发判定

读取以 CONTROL/FRAME 的事务快照时点判定状态，并在 I/O 完成后重新取当前时间检查租约与帧截止。发布或释放在快照之前完成，该次读取看见新状态。快照之后完成的发布或释放，允许已经取得有效快照的在途读取结束，后续新读取须依据更新后的状态。这一规则保持完整快照，避免旧 CONTROL 搭配新 FRAME。

授权失效写入仍通过 IMG-05 的排他锁执行。已进入共享锁的读操作可完成，然后写入方封闭 CONTROL 并提交角色、归属等权威变更。排在失效之后的读操作必须重新鉴权，无法沿用旧权限或缓存图片。客户端继续按协议忽略旧 streamId 的迟到响应，并按原 expiresAt 清图。

## 验证结果

| 检查 | 结果 |
|---|---|
| IMG-07 专项 | PASS，44/44 |
| 最新帧、帧上传、租约与 Media、管理员初始化、设备 Lambda 组合根回归 | PASS，6 个文件、164/164，包含上述 44 项及原有 83 项图片测试 |
| P0 摄像头策略、参考并发模型及图片 API 契约 | PASS，22/22 |
| cloud-api typecheck 与 build | PASS |
| 变更源码与测试的定向 ESLint、Prettier | PASS |
| check-delivered-runtime | PASS，原有 129 个生产操作继续一致 |
| check-boundaries、check-secrets、git diff --check | PASS |

专项覆盖三种响应及 Schema、返回字段清单、读取不延长期限、原图删除和逻辑过期、相同 UUID 大小写、本页与他人租约、角色实时撤销、跨客户、平台用户自己的租约、控制项封闭、帧授权代次、发布和释放的两种快照顺序、I/O 期间到期、在途撤权等待、新客户重开和存储失败脱敏。

```bash
node_modules/.bin/vitest run apps/cloud-api/test/live-image-latest.test.ts apps/cloud-api/test/live-image-frames.test.ts apps/cloud-api/test/live-image-leases.test.ts apps/cloud-api/test/media.test.ts apps/cloud-api/test/admin-runtime-initialization.test.ts apps/cloud-api/test/device-lambda-composition.test.ts
/opt/homebrew/bin/pnpm --filter @fdp/cloud-api typecheck
/opt/homebrew/bin/pnpm --filter @fdp/cloud-api build
node --import tsx --test contracts/domain/camera-interaction-policy.test.ts contracts/domain/live-image-concurrency.test.ts contracts/rest/device-image-api.test.ts
node scripts/check-delivered-runtime.mjs
node scripts/check-boundaries.mjs
node scripts/check-secrets.mjs
```

## 未完成和未运行明细

| 状态 | 事项 | 后续处理 |
|---|---|---|
| FAIL | 当前无未修复失败 | 本批运行的检查均通过 |
| NOT_IMPLEMENTED | DynamoDB 生产事务读取/写入适配器、PostgreSQL 持锁鉴权、权威变更写入口、公开路由和 IaC | IMG-08 交付并对齐本批快照语义 |
| NOT_RUN | 实际 DynamoDB 事务隔离、网络与多实例、跨数据库失效协议及物理 TTL 回收 | 当前采用测试共享存储及读写锁，真实适配器需独立验证 |
| NOT_RUN | 新公开域名路由、Cognito/mTLS 真实身份、云部署、浏览器清图、真机和容量负载 | 后续接线、页面和目标环境验收 |
| NOT_RUN | 全量 pnpm verify、完整 cloud-api 测试集、前端及新云资源验证 | 本批完成定向业务和原入口回归 |

当前无 IMG-07 本地开发阻塞项。下一可执行任务为 IMG-08，先实现共享存储及持锁鉴权生产适配器、权威写入口失效协议，再完成五个预览路由、Lambda/CORS/权限和 IaC 定义接线。真实部署按相应授权与环境条件执行。
