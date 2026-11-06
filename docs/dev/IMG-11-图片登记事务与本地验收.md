# IMG-11 图片登记事务与本地验收

2026-11-06，基于本地提交 `ebacd638` 实施。初始分支 main、工作区干净、已有七个未推送提交。本批不部署、不连接或迁移目标库、不推送。沿用 IMG-09 数据模型与 SQL 约束，没有新增 migration、OpenAPI 操作或 MQTT 字段。

实施依据：[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、[IMG-04 迁移设计](./IMG-04-图片触发引用迁移设计.md)、[IMG-09](./IMG-09-图片触发引用迁移与本地验收.md)及 [IMG-10](./IMG-10-触发图片上传会话与本地验收.md)。本批完成登记和持久化调度意图；关联解析、分钟扫描和正式消费者接线仍是 IMG-12，查询权限为 IMG-13。

## 修改文件

| 文件 | 职责 |
|---|---|
| `packages/media/src/metadata.ts` | 对象预检/持锁提交拆分、精确字节和 Hash、会话重验、登记与 Evidence/Outbox 原子写入、严格重放 |
| `packages/media/src/registration-locks.ts`、`index.ts` | 共享设备、Trigger、会话锁；导出登记预检/提交与 Outbox 常量 |
| `apps/cloud-api/src/media/upload-session.ts` | 使用共享设备/Trigger 锁，与登记遵循相同顺序，保留原有签发、重用和配额行为 |
| `apps/ingestion-worker/src/media/handler.ts` | 事务外 S3 校验，事务内二次身份/归属验证及 receipt、登记写入；重复 receipt 跳过对象读取 |
| `apps/ingestion-worker/src/ingest/receipt.ts` | 未发现自己 receipt 的业务 P2002 原样上抛；禁止在已经失败的调用方事务内回读恢复 |
| `apps/ingestion-worker/test/media-evidence.test.ts` | 登记专项，覆盖两类触发、重复投递、权限变化、精确字节、回滚及 Outbox 重试 |
| `apps/cloud-api/test/media-trigger-sessions.test.ts` | 旧元数据与新办会话竞争、登记先提交及 Evidence 断言 |
| `apps/ingestion-worker/test/ingest-receipt.test.ts` | 业务唯一约束错误不能冒充 receipt Payload 冲突 |
| `apps/ingestion-worker/test/qa03-data-path.test.ts` | 合法八路场景先登记媒体，再处理会自动挂起设备的 tamper；独立负向用例仍验证挂起后拒绝 |
| `vitest.config.mjs` | 为已有共享包 `@fdp/media` 增加源码 alias，确保测试读取当前实现，不依赖旧 dist |
| 本文、开发计划、IMG-04 补充 | 记录边界、故障复验、NOT_RUN 与下一阶段 |

## 登记事务

生产 Media Handler 使用同一个根数据库客户端。S3 HEAD/GET 流式 Hash 在 SQL 事务外完成，先校验规范路径、设备与 Customer、会话文件申报、期限、对象存在、精确长度与 SHA-256。不接受设备自行申报的 Customer 或 triggerRef；引用只来自存储的上传会话及其不可变 Trigger。

`processWithReceipt` 保留原有每设备/Topic advisory lock，然后建立 receipt。登记核心复用该事务，按设备 `FOR UPDATE` → Trigger `FOR NO KEY UPDATE` → 会话 `FOR UPDATE` 顺序持锁。HTTP 新办路径使用相同设备/Trigger 锁，再按 created_at/id 锁该 Trigger 的会话集合。Trigger 锁兼容声明检查和 FK 的 KEY SHARE。生产仍使用 IMG-08 权威写入口包装器，最外层权威屏障先于这些行锁。

设备锁后重新解析原 IoT principal，验证证书设备绑定、撤销状态和轮换截止；设备须仍属于预检 Customer，生命周期仍为 Active/Maintenance。receipt 按消息发生时间解析的历史 Customer 也必须与当前登记范围一致。挂起、退役、取消分配或换租户不能留下归属不一致的 receipt/媒体。沿用 IoT 管线既有证书认证规则，没有另加设备自报身份入口。

拿完锁后重读会话及 Trigger，核对预检所用的不可变申报与当前值，重新取时钟检查期限。仅当前有效 ISSUED 可登记，不能用校验前的时间越过截止；EXPIRED 旧尝试不能登记到替换会话的 key。

同一事务内持久化：

1. receipt（原有通用入口建立）。
2. 会话更新为 COMPLETED，并保存完成时间。
3. MediaObject AVAILABLE，保存源消息、规范路径及实际验证的小写 Hash。
4. 带 triggerId 时创建 MediaEvidence PENDING，保存不可变 Customer/device/kind/messageId 快照；registeredAt 为持锁登记时间，deadlineAt 固定 +24 小时，nextAttemptAt=registeredAt，attemptCount=0。
5. 带 triggerId 时创建唯一 Outbox 调度事件。
6. 登记成功审计和 receipt 缺口处理仍在同一事务。

Media、Evidence、Outbox、审计或最后的缺口处理失败，receipt 和会话更新也回滚。Handler 对未应用结果抛隔离错误，让外层事务回滚。数据库/依赖异常按既有 SQS 重试，不把未提交状态回复为完成。兼容服务入口 `handleMediaMetadata` 没有伪造 MQTT receipt；生产 Handler 才拥有完整 receipt 外层事务。传入调用方事务时不另开事务，其最终提交/回滚由调用方负责。

## 精确校验及重放

| 情况 | 处理 |
|---|---|
| sizeBytes 非空（包括 IMG-10 新建的旧格式请求） | HEAD 长度必须逐字节等于会话 sizeBytes；同 ceil KB 的不同长度仍拒绝 |
| 历史 sizeBytes=NULL | 保留 ceil(bytes/1024)=sizeKb 兼容分支，不猜测或回填历史精确长度 |
| Hash | 流式计算 SHA-256，小写 64 位 hex 与会话申报严格相等；缺失、格式错误或不同均拒绝 |
| 已有相同 receipt/Hash | 跳过 S3 和登记业务，原 receipt 保留；对象不可用或期限过去不妨碍重复确认 |
| 相同 receipt 键、不同 Hash | 原有 PAYLOAD_CONFLICT，原记录不覆盖 |
| 新 seq，原 sourceMessageId 或同会话的新 sourceMessageId | 持锁核对同设备/Customer/会话、完整文件元数据与 captureTime；返回原 mediaId，不新建媒体、Evidence、Outbox 或登记审计；新的合法 seq 可产生自己的 receipt |
| 修改已登记的 captureTime/path/文件元数据 | 拒绝，不能借旧消息 ID 获得任意登记确认 |
| 跨设备复用全局 sourceMessageId | 拒绝，不返回对方 mediaId。竞争唯一键时只在根事务回滚后至多重试一次 |
| 已软删除媒体 | 精确重放返回原 mediaId，保持删除状态；不替换图片、不延长关联截止 |
| 旧版 COMPLETED 绑定媒体缺 Evidence/Outbox | REGISTRATION_INCOMPLETE，失败关闭，不补造注册时间或重置 24 小时窗口。上线前需核对是否存在这类历史中间态 |
| 无 triggerRef 的历史/新会话 | 继续注册 IMAGE/VIDEO，生成 MediaObject、完成会话、receipt 和审计；不猜测触发来源或创建 Evidence |

对象校验仍通过既有 HeadObject 和 GetObject 端口；S3 PUT 签名必须继续绑定 Content-Length 与 SHA-256 checksum，使用服务端签发的唯一 key。没有新增 S3 版本化或对象锁策略。真实 S3 的签名头强制、HEAD/GET 一致性和客户端覆盖行为仍需目标验证。

## Outbox 交接

新增事件类型 `MEDIA_EVIDENCE_REGISTERED`，aggregateType=`media_evidence`，aggregateId 为 Evidence ID，idempotencyKey=`media-evidence:<triggerId>`。Payload 白名单如下：

```json
{
  "schemaVersion": 1,
  "evidenceId": "<evidence UUID>",
  "triggerId": "<trigger UUID>",
  "mediaId": "<media UUID>",
  "customerId": "<stored customer>",
  "deviceId": "<stored device>",
  "triggerRef": { "kind": "ALARM", "messageId": "<original source meta.id>" },
  "registeredAt": "2026-11-06T08:00:00.000Z",
  "deadlineAt": "2026-11-07T08:00:00.000Z"
}
```

不携带图片本体、签名 URL、凭据或原始报文。提交后事件保持 PENDING，可通过已有 `createLeasedOutboxPublisher` 按此 eventType 领取、失败释放租约和持久化重试。本地真实数据库测试验证发送失败再成功、重复轮询无重发，以及现有只消费 ARCHIVE 的 Publisher 不会误发该事件。

本批没有修改 ARCHIVE 的生产过滤器，也没有把登记事件伪装成 Raw Archive。IMG-12 必须新增解析消费者及事件路由，使用 Evidence ID 回查数据库，不信任队列 Payload 决定关联范围；并实现立即首试、每分钟分页扫描及固定 24 小时截止。Outbox 的发送确认和消费者业务幂等是不同边界，需承受至少一次投递。PENDING 及其截止时间在数据库中持久化，不依赖进程内计时器；当前本地代码没有宣称已经在云端执行解析。

## 验证记录

使用隔离 PGlite，按序应用仓库全部 migration。对象存储、队列发送使用本地替身；没有读取生产凭据或调用真实 S3/目标库。

| 检查 | 最终结果 |
|---|---|
| 新登记专项 | PASS，27 项 |
| 登记、会话、receipt 专项 | PASS，3 文件、79 项 |
| cloud-api/database/aws-clients/ingestion-worker/summary-worker 回归 | PASS，140 文件、1274 项，maxWorkers=4 |
| contracts 全套 | PASS，319 项，含旧请求/基线兼容 |
| OpenAPI | PASS，bundle 新鲜度与 Redocly 校验，wire 契约不变 |
| runtime/migration 脚本测试 | PASS，11 项 |
| cloud-api 及依赖、ingestion-worker/summary-worker 类型与构建，infra 构建 | PASS |
| 运行交付清单 | PASS，134 operations |
| 当前产物离线 CDK synth | PASS，无 warning；Lambda asset 及既有接线检查通过，未部署 |
| migration 漂移、包边界、sensitive sinks、secrets | PASS |
| 修改源码 ESLint/Prettier、git diff --check | PASS |

### 曾出现的 FAIL 与修复

保留以下中间失败；修复后的 PASS 不抹去执行历史：

- 首次 worker typecheck：测试夹具将 triggerId 传为 undefined，违反 exactOptionalPropertyTypes。改为显式 null，后续类型检查通过。
- 首轮完整回归：139 文件通过、1 文件失败，1268 项通过、1 项失败。QA03 合法八路夹具按 tamper→media 顺序执行，而 tamper 会自动挂起设备；新的持锁鉴权正确拒绝后续登记。合法流程改为 media→tamper，保留原 80 条成功和重复断言，独立挂起/撤销负向测试继续要求失败；QA03 五项复验通过。
- 新增历史归属负向测试的夹具先缺 Customer/Site FK，随后违反现有 device/customer 插入一致性守卫。补齐真实 Customer/Site，并按旧归属建立历史 assignment 后再迁回当前 Customer，未停用约束。专项最终 79 项通过；中间两次专项均为 78 PASS/1 FAIL。一次同期全回归读取了修复前夹具，139 文件/1273 项 PASS、1 文件/1 项 FAIL，同样保留为中间 FAIL。最终全回归 140 文件/1274 项 PASS。

最终未解决 FAIL=0、BLOCKED=0。故障注入的预期失败（登记各写入点、最后的 gap、对象缺失/Hash/字节不符、授权失效、发送失败）均保留断言和完整回滚检查。

### NOT_RUN

- 原生 PostgreSQL 多连接的行锁竞争、死锁/超时、事务提交失败、连接池和目标负载。PGlite 单后端上的并发 Promise 及受控交错仅证明本地业务顺序/不变量。
- 真实 S3 PUT、签名头服务端强制、精确 Content-Length/校验和实测、真实对象覆盖或版本化行为。
- 真实 AWS IoT/SQS 重复投递和重试耗尽、Outbox 实际发送、Lambda/公开域名、真实设备。
- IMG-12 解析消费者/队列路由/分钟扫描/终态、IMG-13 查询及权限；当前 Evidence 仍为 PENDING。
- 目标数据库连接/迁移、真实历史数据副本、云资源部署、推送、全仓 verify/页面 E2E 和正式目标 Gate。

G2 仍为 PARTIAL：IMG-09～11 本地迁移、会话与登记事务完成，IMG-12～13 和目标证据未完成。拍照白名单、设备规模及首帧等待目标仍 OPEN。

下一可执行任务为 IMG-12：基于本次 PENDING Evidence 和唯一 Outbox 事件实现立即解析、同租户同设备 sourceMessageId 精确匹配、每分钟有界分页重试及 24 小时终态，补齐事件/告警乱序、重复、清除后关联与并发测试；生产消费者及调度接线需与此一起完成。

## 复现命令

本机使用 `/opt/homebrew/bin/pnpm` 10.20.0、Node 24.22.1。以下 pnpm 均指该绝对路径。

```sh
pnpm exec vitest run apps/ingestion-worker/test/media-evidence.test.ts apps/cloud-api/test/media-trigger-sessions.test.ts apps/ingestion-worker/test/ingest-receipt.test.ts --maxWorkers=4
pnpm exec vitest run apps/cloud-api/test packages/database/test packages/aws-clients/test apps/ingestion-worker/test apps/summary-worker/test --maxWorkers=4
pnpm --filter @fdp/cloud-api... typecheck
pnpm --filter @fdp/ingestion-worker typecheck
pnpm --filter @fdp/summary-worker typecheck
pnpm --filter @fdp/cloud-api... build
pnpm --filter @fdp/ingestion-worker build
pnpm --filter @fdp/summary-worker build
pnpm --filter @fdp/infra build
pnpm test:contracts
pnpm openapi:check
node --import tsx --test scripts/check-delivered-runtime.test.mjs scripts/check-migrations.test.mjs
node scripts/check-migrations.mjs
node scripts/check-boundaries.mjs
node scripts/check-sensitive-sinks.mjs
node scripts/check-secrets.mjs
node --import tsx scripts/check-delivered-runtime.mjs
PATH=/opt/homebrew/bin:$PATH AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-1 node scripts/check-cdk-synth.mjs
```

此外对修改 TS 和 Vitest 配置执行定向 ESLint/Prettier 与 git diff --check。本批没有执行 deploy、目标 prisma migrate 或 push。
