# IMG-09 图片触发引用迁移与本地验收

2026-11-06，基于本地提交 `17e2a865` 实施 IMG-09。初始分支 main，工作区干净，已有五个未推送提交。本批只生成迁移并在隔离 PGlite 中执行；不部署、不连接或迁移目标库、不推送 Git。

依据为[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)和[IMG-04 迁移设计](./IMG-04-图片触发引用迁移设计.md)。本批不实现 IMG-10 的 triggerRef HTTP 业务、IMG-11 登记/Outbox、IMG-12 解析任务或 IMG-13 evidenceImage 查询。

## 修改文件

| 文件 | 交付 |
|---|---|
| `packages/database/prisma/schema.prisma` | MediaTrigger、MediaEvidence、上传会话可空字段、父记录唯一键、Prisma 关系与索引；同时按 Prisma formatter 统一对齐 |
| `prisma/migrations/20261106010000_media_trigger_evidence/migration.sql` | 事务式向前迁移、CHECK、普通/复合 FK、部分唯一索引及不可变触发器 |
| 同目录 `schema.sha256` | 当前 Prisma Schema SHA-256，旧迁移不修改 |
| `packages/database/test/media-trigger-migration.test.ts` | 空库/历史库迁移、不可变申报、关联状态、唯一约束、归属、删除、回滚和重试验证 |
| `apps/cloud-api/test/media-migration-compatibility.test.ts` | 旧 REST 请求、旧 MQTT 登记/重放/下载、历史空字段与跨迁移在途会话兼容 |
| 本文、开发计划及 IMG-04 实施补充 | 记录实际约束、检查、历史失败、NOT_RUN 和下一任务 |

已运行 Prisma generate，生成的客户端按仓库既有规则不纳入 Git；数据库包和消费者构建/类型检查验证其可用。REST/MQTT Schema、契约版本、冻结基线及业务 Handler 均未修改。

## 数据结构与唯一约束

### 不可变触发申报

`MediaTrigger` 保存服务端 UUID、customerId、deviceId、kind、原 messageId、mediaType、fileName、sizeBytes、sizeKb、小写 SHA-256 和 createdAt。唯一键为 `(customerId, deviceId, kind, messageId)`，messageId 使用 C collation，逐字符区分大小写。kind 只能 EVENT/ALARM，类型固定 IMAGE，文件名和引用格式与冻结契约一致；精确字节数为 1～10485760，sizeKb 必须等于 ceil(sizeBytes/1024)，Hash 必须为小写 hex64。

新建申报在数据库内持设备共享行锁核对当前 Customer；记录一旦创建，全部字段不可改写，也不允许删除后用同一引用重新申报。Customer/Device 使用独立主键外键，保留申报时的归属快照；设备以后换客户不会级联改动历史申报。

### 会话、字节数与替换

`MediaUploadSession` 增加 `triggerId nullable` 和 `sizeBytes nullable`。历史记录全部保持 NULL，没有从取整 KB、文件名、告警代码、时间或路径猜测来源/精确字节。

任何非空 sizeBytes 都必须为正并与 sizeKb 一致。绑定触发的会话还须完整匹配原申报的 Customer、设备、类型、文件名、精确大小、KB 和小写 Hash；绑定、主键、申报、创建时间与原 URL 到期时间不能修改，终态不能重开。已绑定尝试保留，不允许删除；旧未绑定会话继续原有更新/删除规则，也不能事后补绑触发来源。

部分唯一索引 `media_sessions_one_issued_trigger_key` 限制每个非空 triggerId 同时最多一条 ISSUED。其谓词不依赖时钟：IMG-10 必须先在同一事务内把过期 ISSUED 置 EXPIRED，再创建新会话，不能只因 URL 到期就跳过旧行。旧 triggerId=NULL 的请求不受这个唯一键限制。

IMG-10/11 仍须按 P0 的**设备 → MediaTrigger → 会话**顺序锁定，重验已登记、当前有效会话、配额和原截止。数据库约束不代替这些 HTTP 业务判断。本批旧服务仍走原有分支；新列不会使旧服务自动接受 triggerRef。

### 登记、关联和可用性分离

`MediaEvidence` 的 triggerId、mediaId 分别唯一，alarmId/eventId 也分别唯一。记录保存不可变的触发、媒体和注册时点，并复制 Customer、设备、kind/messageId 四个身份字段。复制字段来自 MediaTrigger，不来自用户请求；这是为复合外键提供的实施细化。

Prisma 保留可直接查询的一对一关系；SQL 另外使用复合外键验证：

- Evidence 与 Trigger 的完整引用及归属相同。
- MediaObject 与 Evidence 的 Customer/设备相同。
- Alarm/DeviceEvent 与 Evidence 的 Customer、设备和原 sourceMessageId 相同。

这些约束同时阻止父记录事后改归属或消息 ID，避免只检查关联写入一侧。新增的父表复合唯一索引包含已有主键，不会要求历史 NULL sourceMessageId 回填或引入额外业务去重。

Evidence 只能从 PENDING 创建，且所选 MediaObject 必须来自同一触发的 COMPLETED 会话。绑定媒体也必须符合原 IMAGE 申报；图片 durationSec 接受既有 NULL/0。绑定媒体的身份、Hash、路径等登记事实不可改写，状态仍可按原 AVAILABLE/DELETED 规则变化。

| 状态 | 数据库要求 |
|---|---|
| PENDING | alarmId/eventId 均 NULL，nextAttemptAt 非空，可更新尝试次数和安全失败码 |
| LINKED | 仅匹配 kind 的目标 ID 非空，复合 FK 精确匹配原来源，nextAttemptAt/failureReason 均 NULL |
| UNMATCHED | 两个目标均 NULL，nextAttemptAt=NULL，必须有安全失败码 |

注册时 deadlineAt 固定为 registeredAt 加 24 小时，不得延长；nextAttemptAt 必须处于该窗口，attemptCount 非负且不能倒退，失败原因限定为最多 64 字符的安全大写代码。LINKED/UNMATCHED 终态不可改写；Evidence 不允许删除重建。告警确认/清除仍可更新状态，媒体软删除不会删除关联；有关联的媒体或来源记录硬删除会被 FK 阻止。

PENDING 到终态的条件更新、每分钟扫描、实际等待截止、CLEARED 消息识别和失败码枚举仍由 IMG-11/12 实现。本批验证关联到**原 ACTIVE 消息创建的 Alarm**后，即使该 Alarm 当前已 CLEARED，关联仍保留；不根据告警当前状态或最近时间猜来源。AVAILABLE/DELETED 是媒体可用性，PENDING/LINKED/UNMATCHED 是关联状态，二者没有合并。

## 历史兼容与发布顺序

迁移不重写或回填既有 Session、MediaObject、Alarm、DeviceEvent。测试分别保留历史 ISSUED/COMPLETED/EXPIRED、IMAGE/VIDEO、NULL/大写 Hash、无会话媒体、DELETED 媒体和无 sourceMessageId 的旧来源记录，比较迁移前后所有原字段。

旧请求样例仍返回原 201 结构，不增加 triggerRef；随后使用原 MQTT media 完成对象登记、重复消息回放、列表和下载。迁移前已签发且 Hash 有效的在途会话，迁移后仍能完成登记，其新列保持 NULL。历史已登记但 Hash/精确字节缺失的媒体仍可按原权限签下载 URL，DELETED 仍拒绝下载。原来缺 Hash 的旧会话不被推断为已校验或已关联。

SQL 显式 BEGIN/COMMIT。人工注入末尾 SQL 失败验证 DDL 回滚到原结构，再执行正确迁移可成功；另在两个全新隔离库重放完整迁移链。这里的可重复验证指受迁移版本管理的一次性执行，在不同空库/历史夹具可复现，不把直接重复执行已应用 SQL 文件当作幂等部署协议。

后续发布先应用加法迁移，再部署兼容旧请求的新服务，最后启用触发引用、登记/解析和查询。回退关闭新增业务写入并保留表、关系和历史记录，不用删除表清理已登记证据。回退还须先停止新签发并排空绑定会话，或保留能处理 triggerId 的兼容消费者；不能让不识别关联的旧消费者继续消费已签发的触发业务。目标上的建索引锁等待、原始数据规模和恢复窗口须预演，本批不推定已经通过。

## 本地验证

本地结果如下；命令见文末。全部测试只使用本地 PGlite、内存对象存储/签名替身和已有 JPEG 样例，不访问 S3 或目标数据库。

| 检查 | 结果 |
|---|---|
| IMG-09 迁移专项 | PASS，25/25 |
| 旧请求/历史/在途会话兼容及原 Media 回归 | PASS，兼容专项 3/3，原 Media 12/12，连同迁移专项共 40 项 |
| database、cloud-api、ingestion-worker、summary-worker 全部测试（maxWorkers=4） | PASS，121 文件、1150 项，包含上述专项 |
| 契约全套 | PASS，319/319；旧请求及两版本基线兼容 |
| Migration 实际结构漂移与脚本负向测试 | PASS；脚本 7/7 |
| Prisma format/generate、database/消费者类型与构建 | PASS |
| OpenAPI、134 运行操作、边界、脱敏与 secret | PASS |
| CDK synth | PASS，从当前数据库构建产物进行 Lambda 打包，无 warning；未部署 |
| 定向 ESLint/Prettier、git diff --check | PASS |

### 历史 FAIL 保留

| 执行中失败 | 修复 |
|---|---|
| 历史夹具缺 customers.updated_at，触发原有 NOT NULL | 按迁移前真实结构补全夹具，不放松生产约束 |
| 父记录 RESTRICT 删除/改键的断言误期望 23503，实测为 23001 | 对齐 PostgreSQL RESTRICT 的实际错误码，保留拒绝行为断言 |
| 生成共享行锁函数时 SQL 美元定界符被替换脚本缩成单个美元符，导致 42601；相关套件初始化被阻止 | 修复迁移 SQL 定界符，重跑实际迁移、漂移和所有受影响测试，不修改旧测试的清理逻辑掩盖失败 |

最终未解决 FAIL=0、BLOCKED=0；上述历史失败不删除，NOT_RUN 不计为 PASS。

### NOT_RUN 与后续依赖

- **NOT_RUN**：目标库连接、prisma migrate deploy、资源部署、Git 推送、真实历史数据全量副本迁移。
- **NOT_RUN**：原生 PostgreSQL 多会话锁竞争、死锁/超时、实际版本/排序规则检查、在线索引锁时长、大数据量空间和回滚窗口。PGlite 单后端的并发调用只证明约束生效，不证明真实多连接竞争。
- **NOT_RUN**：真实 S3 PUT/对象检查、公开域名 mTLS、MQTT/Outbox/receipt 的整链路、设备和浏览器真机。
- **NOT_RUN**：IMG-10 triggerRef 会话业务、IMG-11 同事务登记和 Outbox、IMG-12 重试任务、IMG-13 evidenceImage 权限与返回；数据库 FK 不能证明文件已经过 S3 校验或业务来源消息正确处理。
- **NOT_RUN**：全仓库 verify、admin-web E2E 和正式目标 Gate；本批只对列明的本地范围负责。

IMG-09 本地数据库交付完成后，G2 仍为 PARTIAL，等待 IMG-10～13 与真实流程证据；G0 及 IMG-08 已记录的 G1 边界不变。事件/告警拍照白名单、设备规模和首帧目标继续 OPEN。

下一可执行任务是 IMG-10：在已包装的生产客户端内按设备→触发→会话顺序持锁，落库精确字节和规范化申报，实现 200 有效会话重用、201 过期新办、409 申报冲突/已登记以及并发配额测试。IMG-11 必须让会话完成、媒体、Evidence、receipt 和 Outbox 在同一事务提交，不可提前启用只有部分消费者支持的触发路径。

## 检查命令

本机使用 Node 24.22.1、/opt/homebrew/bin/pnpm 10.20.0。生成/差异 SQL 只使用 Schema 文件，不连接数据库；实际迁移只在 PGlite 测试库执行。

```sh
pnpm --filter @fdp/database exec prisma format
pnpm --filter @fdp/database generate
pnpm exec vitest run packages/database/test/media-trigger-migration.test.ts apps/cloud-api/test/media-migration-compatibility.test.ts apps/cloud-api/test/media.test.ts
pnpm exec vitest run packages/database/test apps/cloud-api/test apps/ingestion-worker/test apps/summary-worker/test --maxWorkers=4
pnpm --filter @fdp/cloud-api... typecheck
pnpm --filter @fdp/ingestion-worker typecheck
pnpm --filter @fdp/summary-worker typecheck
pnpm --filter @fdp/cloud-api... build
pnpm --filter @fdp/ingestion-worker build
pnpm --filter @fdp/summary-worker build
pnpm --filter @fdp/infra build
node scripts/check-migrations.mjs
node --import tsx --test scripts/check-migrations.test.mjs
pnpm test:contracts
pnpm openapi:check
node --import tsx scripts/check-delivered-runtime.mjs
node scripts/check-boundaries.mjs
node scripts/check-sensitive-sinks.mjs
node scripts/check-secrets.mjs
# 只合成当前本地产物，禁用本地凭据配置和 EC2 元数据查询。
AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-1 node scripts/check-cdk-synth.mjs
```

另外对本次变更的两个测试文件执行 ESLint，对测试与变更文档执行 Prettier check，并执行 git diff --check。数据库迁移专项在不同隔离库重放；这些命令没有执行 prisma migrate deploy 或真实回退操作。
