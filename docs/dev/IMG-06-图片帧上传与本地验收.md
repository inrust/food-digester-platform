# IMG-06 图片帧上传与本地验收

2026-11-06，基于本地提交 afd5427e 完成帧上传服务、框架无关 Handler、Base64 与 JPEG 校验、原子发布端口、去重及设备限频。本地模块验收为 PASS，G1 继续为 PARTIAL。实施依据为 [接口设计](../api/device-image-interface-design.md)、[并发设计](./IMG-03-图片预览临时存储与并发设计.md) 和 [IMG-05](./IMG-05-图片预览租约服务与本地验收.md)。本批初始 main 工作区干净，已有两个未推送提交，按本次指令再创建本地提交。

## 代码和数据路径

| 文件 | 实现 |
|---|---|
| [frame-validation.ts](../../apps/cloud-api/src/live-image/frame-validation.ts) | 实际 JSON 字节数、封闭字段、UUID、UTC、标准 Base64、原图大小、JPEG 扫描结构及完整解码校验 |
| [frame-service.ts](../../apps/cloud-api/src/live-image/frame-service.ts) | 持锁鉴权、租约与 streamId 检查、请求摘要、去重、时间窗、帧水位、限频和原子提交 |
| [storage.ts](../../apps/cloud-api/src/live-image/storage.ts) | FRAME、DEDUP、事务快照及 CONTROL/FRAME/DEDUP 一次性提交端口 |
| [handler.ts](../../apps/cloud-api/src/live-image/handler.ts) | createLiveImageFrameHandler，复用租约响应封装、错误脱敏、no-store 和 Retry-After |
| [service.ts](../../apps/cloud-api/src/live-image/service.ts) | 复用准入判断及错误类型，保留跨 stream 和授权代次的设备限频时间 |
| [live-image-fixtures.ts](../../apps/cloud-api/test/live-image-fixtures.ts) | 从原租约测试提取共享的 CAS 存储和鉴权读写锁测试工具，扩展原子帧事务模拟 |
| [live-image-frames.test.ts](../../apps/cloud-api/test/live-image-frames.test.ts) | 新增 52 项帧测试；原租约 31 项测试继续运行 |

包入口同步导出帧服务、Handler 和存储类型。OpenAPI 的新预览接口继续标记 planned，生产路由和资源按 IMG-08 接入。

### 上传及图像校验

Handler 验证设备身份上下文存在、Content-Type 为 application/json，可带 charset 参数。生产 HTTP 适配器须把原始 JSON 文本作为 body 传入，先按 UTF-8 字节数限制到 184320，再 JSON.parse。业务服务也支持已解析对象供内部调用，此时只校验其序列化字节数。接线阶段不能只传经过规范化后的 JSON 而丢失原始空白与转义的体积。

请求只允许 streamId、frameId、capturedAt、mimeType、imageBase64，字段均为字符串。UTC 验证同时核对日历日期，拒绝非法日期归一化、24 点时间和非 UTC 偏移。Base64 限定标准字符、长度和填充，并通过解码再编码逐字比较拒绝非规范填充位。原图最多 131072 字节，MIME 固定 image/jpeg。

新增固定依赖 jpeg-js 0.4.4，并配置 tolerantDecoding=false、RGB TypedArray、2073600 像素及 64 MiB 解码内存预算。64 MiB 是本批解码器实现参数，其计量为库的近似分配预算，整体进程资源和运行时间仍需目标负载验证。解码后再次核对宽高各最多 1920 和总像素上限。 [解码器参数说明](https://github.com/jpeg-js/jpeg-js#decode-options)

本地检查发现，解码器会接受仅包含帧头、没有扫描数据的 JPEG，并返回空白像素。因此在完整解码前，按有界 JPEG 段长遍历检查真实 SOS、组件数及非空扫描数据，跳过 COM/APP 元数据中的伪标记。SOI、最终 EOI、段结构和实际解码均须通过。测试覆盖最大有效画幅、伪头、截断图及 COM 中伪 SOS。

### 去重和原子替换

服务在同一设备鉴权读锁内取得 CONTROL 与该 streamId/frameId 的 DEDUP 事务快照。UUID 用规范化值定位存储键。请求摘要对固定字段顺序的 JSON 计算 SHA-256，改变 JSON 字段排列或空白不会改变摘要，改变字段值则会改变摘要。

当前授权、Customer、CONTROL enabled、streamId 和至少一个有效租约检查通过后，15 秒内同摘要重放返回原 receivedAt 和 expiresAt，并设置 replayed=true，保持帧、配额时间和水位不变。相同 ID 异内容返回 FRAME_CONFLICT。即使帧 10 秒已过期，仍可在 15 秒去重窗口内取得原接收结果，响应中的原截止时间保持不变。

新帧先检查时间和速率，符合条件后做 JPEG 解码，再取新时钟复查截止。采集时钟最多超前 2 秒，采集时间必须严格大于该流最近水位。帧截止取采集时间加 10 秒与接收时间加 10 秒的较早值，已到期返回 STALE_FRAME。

commitFrame 必须在一个条件事务中更新 CONTROL 的 revision、水位、限频时间，并写 FRAME 和 DEDUP。条件同时覆盖 revision、authEpoch、Customer、streamId、enabled、有效租约和时间约束。失败没有部分写入，条件冲突最多重试 5 次，每次重新鉴权、读取和检查时钟。存储提交时还须使用适配器的新时钟校验期限并约束 I/O 时长。

每设备新帧间隔至少 1000ms。同内容重放通过去重处理。为满足设备级限制，IMG-06 将 lastNewFrameAtMs 保留在流切换、最后租约释放及授权失效重置之后，仅采集时间水位随流清空。测试验证快速重开及重置不能绕过限频。

### 授权与失败恢复

最后租约释放与传帧都修改同一 CONTROL，陈旧帧提交的 revision 条件失败后重读，返回 LIVE_STREAM_INACTIVE。撤权使用 IMG-05 的排他锁及 epoch 封闭，等待已进入的读操作完成后阻止后续新帧和缓存回执。客户变更后重新启用产生新 epoch 和 streamId，旧流及旧回执不能用于新客户。

提交成功而 ACK 丢失时，设备原样重试，从同一事务的 DEDUP 恢复原结果。未知依赖异常响应 503 并脱敏，重试耗尽也为 503。物理保留的旧 FRAME 不代表可见，IMG-07 读取时必须校验当前租约、授权代次、streamId 与逻辑截止。

## 本地检查结果

| 检查 | 结果 |
|---|---|
| 帧上传专项 | PASS，52/52 |
| 原租约专项 | PASS，31/31，提取测试工具后用例保持完整 |
| 两个专项加 Media、管理员初始化及设备 Lambda 组合根回归 | PASS，5 个文件共 120/120，包含上述 83 项 |
| P0 摄像头策略、参考模型及图片 API 契约 | PASS，22/22 |
| cloud-api typecheck 与 build | PASS |
| 变更源码与测试的定向 ESLint、Prettier | PASS |
| check-delivered-runtime | PASS，原有 129 个生产操作保持一致 |
| check-boundaries、check-secrets、git diff --check | PASS |

复现命令如下。

```bash
node_modules/.bin/vitest run apps/cloud-api/test/live-image-frames.test.ts apps/cloud-api/test/live-image-leases.test.ts apps/cloud-api/test/media.test.ts apps/cloud-api/test/admin-runtime-initialization.test.ts apps/cloud-api/test/device-lambda-composition.test.ts
/opt/homebrew/bin/pnpm --filter @fdp/cloud-api typecheck
/opt/homebrew/bin/pnpm --filter @fdp/cloud-api build
node --import tsx --test contracts/domain/camera-interaction-policy.test.ts contracts/domain/live-image-concurrency.test.ts contracts/rest/device-image-api.test.ts
node scripts/check-delivered-runtime.mjs
node scripts/check-boundaries.mjs
node scripts/check-secrets.mjs
```

## FAIL 历史与未运行项

| 状态 | 事项 | 处理或后续阶段 |
|---|---|---|
| FAIL → PASS | 离线安装缺包元数据 | 经联网安装固定 jpeg-js 版本，锁文件只增加该依赖 |
| FAIL → PASS | 提取测试工具时漏导出证书样例，新测试初稿多一个括号 | 修正后原 31 项及新增帧测试全部通过 |
| 发现并修复 | 仅帧头的 JPEG 被解码器接受 | 补真实扫描结构检查及伪扫描回归用例 |
| 发现并修复 | 原租约清空限频时间可能让流重开绕过设备间隔 | 限频时间跨流及授权重置保留，新增回归用例 |
| NOT_IMPLEMENTED | DynamoDB 生产事务适配器、PostgreSQL 持锁鉴权及权威写入口、公开路由与 IaC | IMG-08 按原子端口和失效协议接线 |
| NOT_RUN | 真实 DDB 条件表达式、跨服务失败、多 Lambda 实例、物理 TTL、网络延迟跨越截止 | 本批使用测试共享存储和读写锁，适配器及目标环境须分别验证 |
| NOT_RUN | 网关原始请求字节限制、公开域名 mTLS、新接口部署、真机及解码 CPU/内存负载 | 接线和目标验收阶段 |
| NOT_RUN | 全量 pnpm verify、完整 cloud-api 测试集、前端及新资源验证 | 本批为定向业务、契约、构建及已有入口回归 |

当前无 IMG-06 本地开发阻塞项。下一可执行任务为 IMG-07，增加 CONTROL 与 FRAME 的事务快照读取，并实现 READY、UNCHANGED、WAITING_FRAME、当前查看者鉴权及过期清图响应。
