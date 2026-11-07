# IMG-19 云端组合集成与本地验收

2026-11-07，基于 `8925cb6ad59478b1fa220fdb5f1ac6102e27126d`。进入时 main 工作区干净，已有 15 个未推送提交；已检查根 AGENTS.md，按用户明确要求只创建本地提交，不推送、不部署、不连接或迁移目标库、不启用目标设备。

## 结论与 G3

**IMG-19 为 PASS_LOCAL_COMPOSITION；G3 保持 PARTIAL。** 正常入口的组合验证完成，新增 22 项并修复三处实际接口衔接问题。IMG-20 的完整质量门禁与证据收口尚未执行，不能把本批适用检查等同全仓 pnpm verify 或正式 G3 通过。

[本地机器记录](../audit/evidence/2026-11-07-device-image-IMG19-local.json)绑定参考提交和本批 8 个运行/测试源码的 SHA-256，列出命令、结果、历史失败及 NOT_RUN；它不是正式 Gate receipt。App 实现及真机验收为第三方 OUT_OF_SCOPE，不是本批 BLOCKED 或下一项前置。

## 组合路径与替身边界

测试复用仓库正常入口，没有绕过 HTTP 参数解析、JWT、Schema、业务分发或 receipt：

1. 前端 SessionManager → ApiClient/createHttpApiFetch → 真实预览 API 适配器 / 会话引擎。
2. 本地传输将实际序列化 HTTP 输入交给 createAdminLambdaRouter + createAdminRoute + CORS，含生产账户检查 Hook、本地 RS256 签名/JWKS 和真实 Handler。
3. 设备输入走 createDeviceApiLambdaHandler，从可信 Gateway context 提取证书，走原设备 Handler、证书指纹、数据库准入及当前归属/角色校验。
4. PostgresLiveImageAuthorization 与 withLiveImageAuthority 使用真正 Prisma 和按序执行全部现有迁移的 PGlite。撤权、角色/账号/租户变化、白名单关闭及恢复都经权威写协议。
5. SQS envelope → 身份/Schema/时间检查 → createBusinessDispatcher → Event/Alarm/Media Handler → 同事务 receipt/MediaObject/Evidence/session/Outbox。
6. runMediaEvidenceWorker 消费持久 Outbox 和分钟扫描，再经正常管理路由读取 evidenceImage、申请下载 URL。

预览存储是既有 TestControlStore：分离快照与 CAS/帧原子发布的本地端口；它不是 DynamoDB。对象是内存 JPEG 字节与签名桩，不执行 S3。PGlite 为本地 PostgreSQL 实现，单连接调度不能证明原生多连接行锁竞争。完整 Vitest 也运行了既有 DynamoDB SDK 命令/事务/期限测试，但仍不代表真实 DynamoDB 原子性验收。

证书仅为本地指纹匹配材料，不是实际 TLS 握手凭据。JWT 在进程内签发，不访问 Cognito。跨层测试不访问网络；浏览器测试只访问本地 Vite 及 qa05 拦截的 API/图片。需要云环境的冷启动 Secrets/AWS 初始化未执行，不冒充公开 Gateway 验证。

## 本批修复

| 触发与之前行为 | 修复后 |
|---|---|
| 页面租约 PUT 发送 `{}`，云端严格无请求体校验返回 400 | 前端省略实体，遵守冻结 OpenAPI；服务端校验保持严格 |
| 页面发 afterFrameId，云端读取 knownFrameId，同帧仍返回 READY | 使用冻结 knownFrameId，正常客户端经真实 Lambda 返回 UNCHANGED 且无 Base64 |
| 合法 MQTT Alarm severity=HIGH 被原样返回管理 API，违反 MAJOR 枚举 | 管理端读取将 HIGH 表达为 MAJOR，MAJOR 筛选同时匹配历史 HIGH 与 MAJOR；不改 MQTT、receipt Hash、数据库原值或冻结 wire 枚举 |

旧 IMG-14/15 页面 mock 检查结果保留为当时的本地证据，本批正常入口组合证明这些 mock 未覆盖的衔接缺口并予以修复，不把过去的 mock PASS 追溯为实际云端通过。

## 新增场景覆盖

| 场景 | 实际断言 |
|---|---|
| 两个独立身份/页面查看者 | 真实 JWT 路由申请同一 stream，各自 viewer 独立；一个退出后另一仍能读图，不能冒用对方 viewer |
| 最后释放与上传并发 | Promise 并发请求，无论上传在释放前被接收或被拒绝，最终 IDLE/旧查看租约失效；新流拒绝旧流帧 |
| 重复、顺序与限频 | 相同帧并发只发布一次，原截止一致；变申报冲突、旧帧不覆盖、新帧过快返回 429 和 Retry-After |
| 帧与租约截止 | 10 秒到期 WAITING_FRAME，30 秒租约到期拒绝旧查看者，不靠 TTL 清扫；原浏览器独立清图回归保留 |
| 预览存储故障 | 提交异常返回脱敏 503，无半帧/半 receipt；相同帧重试恢复，期限不延长 |
| 实际页面引擎恢复 | 真实后端 503 → 页面无图恢复态 → 新 viewer/stream → WAITING → 新帧；数据库撤权后 error 停止，超过一个读周期不再请求 |
| 角色/账户/状态/能力失效 | 当前 DB 角色、禁用账户、挂起、退役、关闭白名单清空旧流和租约；拒绝旧 JWT/旧流 |
| 显式恢复 | 挂起改回 Active 不自动重开已关闭 CONTROL；通过既有白名单权威入口恢复，建立新流且无旧帧 |
| 租户迁移 | 旧 JWT 范围被拒绝，新租户新身份建立不同 stream；同设备证书不能用旧 stream 复活图片 |
| 在途读取与撤权写入 | 授权读取排空后写入提交；写入后新读取拒绝，新流看不到旧帧。已获授权的在途响应不等于网络字节可被服务端撤回 |
| 预览与两类归档同时运行 | Event/Alarm 各覆盖 source-first/media-first；预览不创建归档会话，归档不改变有效预览流，原图登记只消耗一个会话 |
| 乱序、重复与清除 | 两份同 MQTT 正常入口投递只有一条 media receipt/对象/Outbox；媒体先到走分钟扫描，Alarm 清除后仍精确关联原 ACTIVE |
| 登记/读取/删除 | 重复 POST 得到 409 MEDIA_ALREADY_REGISTERED + mediaId；真实管理查询 AVAILABLE、签名下载、删除后 DELETED/下载拒绝 |
| 新旧会话竞争 | 同申报四次并发只新签一次；到期新办后迟到旧路径被隔离，新会话登记获胜，原触发唯一关联 |
| 对象依赖失败与 24h 终态 | S3 替身异常进入 SQS partial failure，未留 receipt；同消息恢复成功，未到原事件最终有界扫描转 UNMATCHED |
| 实际事务回滚 | 本地 SQL trigger 在 Outbox 插入时失败，真实事务回滚对象/Evidence/receipt；解除故障后同消息成功 |
| 校验期间撤证或迁移 | 对象 Hash 校验暂停期间修改权威状态，随后提交重验并隔离，未留部分登记 |
| 双页面浏览器 | 两个独立页面组件共享模拟流；退出一页后另页继续 knownFrameId 读取，后端拒绝后清图停读 |

每个跨层 HTTP JSON 响应都按原 OpenAPI 校验，预览还检查 no-store/CORS。未把错误原文、JWT、Base64 或签名 URL 打进测试诊断日志。并发请求在本地 PGlite 上可能由连接串行排队，表中“并发”不宣称目标原生 SQL/DynamoDB 的竞争已被验证。

## 修改文件

| 文件 | 内容 |
|---|---|
| `apps/cloud-api/test/device-image-integration-fixtures.ts` | 生产构造器组合、迁移数据库、真实鉴权、正常 SQS/HTTP 输入、替身端口与逐响应契约断言；不相关路由若调用即失败 |
| `apps/cloud-api/test/device-image-composition.test.ts` | 13 项预览、授权、并发及真实页面引擎场景 |
| `apps/cloud-api/test/device-image-archive-composition.test.ts` | 9 项两链路、乱序、事务、SQS 恢复和校验期授权失效场景 |
| `apps/admin-web/src/pages/devices/live-image-api.ts` | 无实体租约 PUT、knownFrameId |
| `apps/cloud-api/src/admin/alarm/service.ts` | HIGH/MAJOR 读取与筛选兼容 |
| `apps/admin-web/test/live-image-api.test.ts`、`live-image-session.test.ts` | 同步实际冻结请求，保留串行读取、去重和期限测试 |
| `apps/admin-web/e2e/live-image-shared-viewers.spec.ts` | 新增双页面组件共享与权限拒绝浏览器验证 |
| 本地 JSON 记录、本文、开发计划、IMG-04、第三方留档说明 | 源摘要、G3 状态、失败/未执行明细及严重度表示说明 |

没有新增数据库迁移、改策略值或重新生成 wire 契约。两个测试专用 DOM lib 引用仅用于跨包调用真实浏览器客户端类型，不改 cloud-api 生产 tsconfig；生产构建单独检查。

## 本地检查

Node 24.22.1，`/opt/homebrew/bin/pnpm` 10.20.0。日志 `/tmp/img19-*.log` 为本地临时证据。命令从仓库根执行：

| 检查 | 结果 |
|---|---|
| 正常入口组合两个新测试文件 | PASS，22 项，2 文件 |
| `pnpm exec vitest run --maxWorkers=4` | PASS，2170 项，220 文件 |
| Playwright live-image-preview / recovery / shared-viewers / evidence-image | PASS，10 项，含查看/操作页、移动布局、双语、期限与留档 |
| `pnpm --filter @fdp/cloud-api... typecheck`、`pnpm --filter @fdp/admin-web typecheck` | PASS |
| `pnpm --filter @fdp/cloud-api... build`、Playwright webServer 中的 admin-web build | PASS，保留 Vite 大分块 WARN |
| `pnpm test:contracts` | PASS，319 项 |
| `pnpm openapi:check` | PASS，bundle 与 Redocly |
| IMG-17/18 对接包两份 node:test | PASS，12 项，导出新鲜度与样例兼容 |
| runtime/migration/CDK 检查脚本 node:test | PASS，17 项 |
| delivered-runtime / admin-web-delivery | PASS，134 operations、前端交付检查 |
| migrations / boundaries / sensitive-sinks / secrets | PASS，PGlite 实际迁移漂移与静态门禁 |
| 离线 CDK synth | PASS，无 warning；禁用 metadata/凭据，合成 account/region，未部署 |
| 本批源码 ESLint、支持文件 Prettier、文档链接、摘要校验、git diff --check | PASS |

复现新组合：

```bash
pnpm exec vitest run apps/cloud-api/test/device-image-composition.test.ts apps/cloud-api/test/device-image-archive-composition.test.ts --maxWorkers=2
pnpm --filter @fdp/admin-web exec playwright test e2e/live-image-preview.spec.ts e2e/live-image-recovery.spec.ts e2e/live-image-shared-viewers.spec.ts e2e/evidence-image.spec.ts
```

### FAIL / 修复明细

- 正常入口第一项初轮 FAIL：租约 PUT 返回 400；修复多发 `{}`。第二轮 FAIL：期望 UNCHANGED 实为 READY；修复查询名。未放宽服务端校验或改契约。
- 增加逐响应契约断言后，两个 ALARM 场景因 HIGH 不符合管理响应枚举 FAIL；修复读取兼容并断言 DB 仍为 HIGH、MAJOR 筛选可读取。
- 测试夹具早轮 FAIL：禁用账户实际 401/UnauthenticatedError 而非 403；挂起恢复按权威协议保持关闭，需要显式恢复入口。按既有规则修正断言，没有放开鉴权或自动重启。
- 归档夹具早轮缺少不相关管理路由分组，路由表构造报 500；补齐调用即失败的占位路由，只保留相关真实 Handler。根 delegate spy 未影响事务 tx delegate，回滚断言 FAIL；改为真实本地 SQL 故障注入，不伪造回滚。
- 页面引擎测试初轮在冻结服务器时钟上立即发第二张新帧，正确触发 429；推进本地时钟后继续，不改限频策略。
- 类型检查曾因跨包浏览器 RequestCache / Headers.entries 缺 DOM/DOM.Iterable 类型而 FAIL；在测试夹具引入 lib，不放宽生产类型。一次编辑辅助脚本语法错误未落盘，后用补丁完成。

最终未解决 FAIL=0，BLOCKED=0。保留上述历史失败，不以最终 PASS 覆盖。

### WARN

保留 Vite 超过 500kB 分块和 Playwright NO_COLOR/FORCE_COLOR 提示，未调阈值或屏蔽。未形成性能/SLA 结论。

### NOT_RUN

- `pnpm verify` 全量质量门禁、完整历史 Playwright 和正式 IMG-20/G3 receipt；本批只执行列出的全部 Vitest、10 项浏览器及适用脚本。
- 原生 DynamoDB 事务并发、跨进程读写/TTL 清扫，以及原生 PostgreSQL 多连接锁/提交竞争；本机 PATH 未检测到 docker/postgres/initdb，没有安装或启动这些服务。本地 CAS/SDK 单测/PGlite 不替代这些证据。
- 公开 Gateway/Cognito/真实 mTLS、实际 S3/IoT/SQS/Outbox 跨服务链路、真实网络缓存/撤权传播、负载和延迟测试。
- 云部署、目标库连接/迁移、目标白名单/设备启用、Git 推送。

所有准入、证书、归属、SQL 故障注入只发生在临时 PGlite 和本地存储替身中。没有连接目标库或启用真实设备。App/真机仍属 OUT_OF_SCOPE，不列为 BLOCKED 或本批补齐条件。

下一可执行任务：IMG-20，基于本地候选收口云端质量门禁、源摘要与证据；涉及真实服务的步骤继续按授权/可执行范围区分 NOT_RUN，不自动部署或启用目标设备。
