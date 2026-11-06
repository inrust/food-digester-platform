# IMG-12 图片关联解析与本地验收

2026-11-06，基于本地提交 `ad12a84d` 实施。初始 main 工作区干净，已有八个未推送提交。本批仅本地开发、隔离数据库验证和离线 synth，不部署、不连接或迁移目标库、不推送。

依据：[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、[IMG-04 迁移设计](./IMG-04-图片触发引用迁移设计.md)、[IMG-11 验收](./IMG-11-图片登记事务与本地验收.md)。本批完成解析及后台运行接线，告警/事件 HTTP evidenceImage 查询和读取权限仍属 IMG-13。

## 修改范围

| 文件 | 职责 |
|---|---|
| `packages/media/src/evidence.ts`、`index.ts` | 关联解析端口、事务内锁与精确范围匹配、分钟重试时间、24 小时终态 |
| `apps/ingestion-worker/src/media/handler.ts` | 登记根事务提交后立即首试；失败保留已提交数据，交给持久化恢复 |
| `apps/ingestion-worker/src/media/evidence-worker.ts`、`index.ts` | 读取权威 Outbox 后分派解析；有界 keyset 扫描、单行失败隔离和汇总 |
| `apps/ingestion-worker/src/runtime/media-evidence-entry.ts` | 独立分钟 Lambda 入口、总时间预算、失败传播和安全计数日志 |
| `packages/database/prisma/migrations/20261106020000_media_evidence_clear_lookup/` | CLEARED 原消息的部分表达式索引，以及当前 Prisma Schema 的 SHA-256 快照；不改模型或历史行 |
| `infra/src/stacks/app-dependencies-stack.ts`、`database-capacity.ts` | 独立 Lambda、每分钟规则、DLQ/告警、数据库密钥权限和连接预算 |
| `scripts/check-cdk-synth.mjs` | 新 Lambda 加入必须使用真实资产的检查清单 |
| `apps/ingestion-worker/test/media-evidence-resolution.test.ts` | 事件/告警、乱序、重复、精确匹配、清除后关联、终态、分页、并发及恢复测试 |
| `apps/ingestion-worker/test/media-evidence-entry.test.ts` | 真实本地组合根、初始化、时间预算、配置缺失和部分失败触发重试 |
| `apps/ingestion-worker/test/media-evidence.test.ts` | 原登记原子性断言保留；首试后 PENDING 的 attemptCount/nextAttemptAt 更新为新行为 |
| `infra/test/media-evidence-wiring.test.ts` | 资产、分钟规则、重试/DLQ、权限、并发及池预算专项 |
| `infra/test/app-stack.test.ts`、`live-image-wiring.test.ts`、`qa09-performance.test.ts` | 同步新增资源数量、独立角色及连接预算，不降低断言 |
| 本文、开发计划和 IMG-04 补充 | 实施边界、检查记录、NOT_RUN 和下一任务 |

## 解析规则与事务

仅使用 Evidence 中已持久化、不可变的 kind/messageId/customerId/deviceId，不按 code、时间接近程度、文件名或当前设备租户猜测。

1. 单条解析锁 Evidence `FOR UPDATE`，重读状态。不存在返回 NOT_FOUND；已 LINKED/UNMATCHED 返回 TERMINAL，无任何更新时间或计数变更。
2. deadlineAt 尚未到达、nextAttemptAt 在未来时返回 NOT_DUE，重复 Outbox/扫描不会增加尝试次数。
3. 按 kind 在 Alarm 或 DeviceEvent 的 sourceMessageId 唯一键逐字符查找，并持 `FOR KEY SHARE`，使目标复合归属键在本事务中保持稳定。只有原 Customer 和 deviceId 同时相等才能 LINKED，数据库复合 FK 和唯一键继续兜底。
4. 已存在但范围不符的目标转 UNMATCHED。未找到目标先保留 PENDING；只查询指定种类，不用另一类来源替代。
5. 提交状态前再次取服务器时钟，`now >= deadlineAt` 时无条件 SOURCE_TIMEOUT，不允许等待锁或查询期间越过截止后再 LINKED。deadlineAt 始终为原 registeredAt +24 小时，不重新起算。
6. 一次实际尝试通过 `status=PENDING AND attemptCount=原值` 条件更新，attemptCount 原子 +1。PENDING 的下次时间为 `min(本次完成时间+60秒, 原deadlineAt)`；终态 nextAttemptAt=null，LINKED failureReason=null，UNMATCHED 不保存任何目标 ID。

终态与重试调度在同一事务中更新；失败回滚全部修改，保留可重试原状态，不写入半完成的关联。解析不读取 S3，不重新执行图片登记或配额逻辑。文件软删除仍可建立/保留原历史关联。

解析沿用生产的 IMG-08 权威写入口包装器。登记继续遵守设备→Trigger→会话顺序；解析只锁既有 Evidence→来源键，不反向获取设备/会话锁。不会按设备当前归属阻断原客户历史照片：目标和 Evidence 都属于旧 Customer 时，后续设备转租户不迁移或破坏该关联；新客户同设备的来源不能绑定旧照片。

## ACTIVE 与 CLEARED

Alarm.sourceMessageId 保存创建该行的 ACTIVE 消息 ID。告警后来 ACKNOWLEDGED/CLEARED，都可通过原 ID 关联；重复激活 MQTT 经 receipt 去重后不会重建告警或恢复已清除状态。

CLEARED 消息自身不创建 Alarm 行。解析在未找到 Alarm 时查询已提交 ARCHIVE Outbox 的权威映射列：topicType=alarm、columns.status=CLEARED、messageId 精确相等，再检查记录的 Customer/device。匹配到清除消息引用时转 UNMATCHED，不把它附着到同 code 的原告警。

| failureReason | 含义 |
|---|---|
| SOURCE_SCOPE_MISMATCH | 精确消息来源已存在，但原 Customer 或设备不符；不泄露其他范围的目标 ID |
| CLEARED_MESSAGE_REFERENCE | 引用本设备本 Customer 的 CLEARED 消息，而非原 ACTIVE |
| SOURCE_TIMEOUT | 到达固定 24 小时截止；迟到来源或重复任务不能重新打开终态 |

新增向前 migration 只创建 `outbox_alarm_cleared_source_idx`，索引覆盖 ARCHIVE/alarm/CLEARED 下的 messageId 表达式。参数化 SQL 与索引谓词一致，PGlite EXPLAIN 在禁用顺序扫描时确认使用该索引。Prisma 模型及生成类型没有变化，最新 migration 附相同当前模型的 schema.sha256。

现有实现不清理这些 Outbox 行。后续保留策略至少须覆盖所有仍 PENDING 的引用等待窗口；若历史 CLEARED 映射已不存在，解析不会猜测关联，会等至 SOURCE_TIMEOUT。索引在真实大表的构建时间、写入影响和锁预算尚未验证。

## 首试、Outbox 与分钟扫描

生产 Media Handler 在 receipt/图片/Evidence/会话/Outbox 根事务提交后立即调用解析；仅新登记首试，精确重放不重复触发。调用方外层事务模式不在尚未提交时首试，由外层提交后的 Outbox 恢复。首试异常只记录固定事件 `media.evidence.immediate_retry_pending`，不会伪称回滚已提交图片，也不丢弃持久化调度意图。

`MediaEvidenceFn` 在每分钟规则中运行：

- 复用既有 `createLeasedOutboxPublisher`，只领取 MEDIA_EVIDENCE_REGISTERED，单批至多 50 条。分派前按 event.id 重新读取数据库 Outbox，验证类型、aggregateType、schemaVersion、Evidence ID 和 `media-evidence:<triggerId>` 唯一键；消息载荷不能指定目标或租户。解析以权威 Evidence 回查。
- 复用持久化租约、发送失败计数及最多 8 次尝试；没有新增 SQS 业务队列，Outbox 回调直接调用数据库解析。解析提交后再标记 PUBLISHED，确认丢失时重放不改变终态。PUBLISHED 仅表示已执行调度，来源尚未到达时仍可能是 PENDING；分钟扫描继续负责后续重试。
- Outbox 阶段在每行前检查 15 秒软预算，为扫描保留时间，不因 ARCHIVE 或登记事件积压跳过所有扫描。ARCHIVE Publisher 仍保持原来的独立过滤和路由。
- 扫描固定本轮 cutoff，只查 `PENDING AND nextAttemptAt<=cutoff`，按 `(nextAttemptAt,id)` keyset 分页，保存查询时原元组，不因更新下一次时间而重复处理。默认每页 50、最多 5 页，共最多 250 行；配置边界为每页 1～100、页数 1～20。
- 每页、每行检查总时间预算；运行入口在 45 秒或 Lambda 剩余时间不足 10 秒时停止启动下一行。预算为调用间软边界，不宣称能撤销已经发出的数据库请求。单行解析异常回滚、计 failed，继续本批后续行；下一次 tick 会再次发现仍到期的 PENDING。
- runtime 在 scan.failed、Outbox retried/failed 非零时抛固定批次错误，使 EventBridge 重试/DLQ 和 Lambda Errors 告警保持有效。预算用尽属于正常 BUDGET，不伪称队列清空；剩余到期项留给后续 tick。

一次扫描受页数和时间限制，24 小时是允许 LINKED 的硬截止，终态的实际落库时间取决于调度、数据库可用性及积压。恢复后访问过期项只会 UNMATCHED，不能迟到 LINKED。

## IaC 与权限

新增 `media-evidence` Lambda：60 秒超时、reserved concurrency=1，独立角色和真实打包入口；每分钟规则沿用 `enableScheduledWorkers`，未启用时保持 DISABLED。本批未改变目标环境开关。

规则配置最大两次 EventBridge 重试、1 小时事件年龄，独立加密 DLQ 保留 14 天，并配置 Lambda Errors/DLQ 可见消息告警。消费者只需要数据库 Secret 与既有 CONTROL 写入屏障权限，没有 S3、IoT 或 SQS 业务发送权限，也没有 JPEG payload 表访问权。

连接预算纳入新增函数。QA09 capacity + immediate-command 组合的 steadyConnections 由 45 调整至 46，加运维/重叠预留后 required=64、ordinarySlots=70、headroom=6；该组合池上限为 1。默认旧组合仍按池上限 2 计新增两个连接，原有容量规则未被放宽。离线计算和 synth 不替代目标数据库实际容量验收，也不沿用旧候选的 QA09 运行结果。

## 本地验证

测试使用隔离 PGlite 按序应用所有 migration、真实 Prisma、真实事件/告警 receipt Handler 和媒体登记核心。对象读取及 AWS 初始化使用本地替身；未使用生产凭据或发送云请求。

| 检查 | 最终结果 |
|---|---|
| 解析专项 | PASS，31 项 |
| 登记、解析、runtime 三文件专项 | PASS，62 项 |
| cloud-api/database/aws-clients/ingestion-worker/summary-worker/infra 回归 | PASS，154 文件、1379 项，maxWorkers=4 |
| contracts 全套 | PASS，319 项，wire/旧请求基线不变 |
| OpenAPI | PASS，bundle 新鲜度和 Redocly |
| runtime/migration/CDK 检查脚本测试 | PASS，17 项 |
| cloud-api 及依赖、ingestion-worker、summary-worker、infra 类型与构建 | PASS |
| 迁移漂移 | PASS，包括新索引 migration 和模型摘要 |
| 交付运行清单 | PASS，REST 仍为 134 operations |
| 当前产物离线 CDK synth | PASS，无 warning，新 Lambda 纳入真实资产检查；未部署 |
| 包边界、sensitive sinks、secrets | PASS |
| 修改源码 ESLint、Prettier 和 git diff --check | PASS |

覆盖来源先到/图片先到、原告警清除后关联、清除引用晚到、同 code 多告警、源 MQTT 重复、大小写/种类差异、跨设备/租户、设备转租户、文件已删除、24 小时等号及读锁跨截止、并发首试/Outbox/扫描、相同 due 元组分页、多轮推进、页数/时间预算、单行失败后继续、完整解析回滚、首试失败后持久化恢复，以及分钟入口失败传播。

### 中间 FAIL 保留

- migration 门禁首次因新目录缺 schema.sha256 失败；脚本测试同因出现 16 PASS/1 FAIL。补齐当前 Prisma Schema 原始字节 SHA-256，门禁与 17 项脚本复验通过，没有修改旧迁移或取消漂移检查。
- 首次接线专项为 76 PASS/2 FAIL：旧 SQS 数量断言未计新增调度 DLQ（11→12）；新测试启用 QA09 capacity 却缺少仓库要求的 request-observability 前置开关。同步精确资源计数并为测试补齐合法配置，未绕过构造器校验；后续全回归通过。
- 首次定向 ESLint 发现解析测试一个未使用常量导入；删除无用导入，ESLint 及该专项复验通过。

最终未解决 FAIL=0、BLOCKED=0。主动注入的事务/发送失败是保留的预期负向断言，不计为门禁未解决失败。

### NOT_RUN

- 原生 PostgreSQL 多连接 Evidence/来源键锁竞争、死锁、提交失败、连接池及负载。PGlite 的并发 Promise、事务及受控时钟只证明本地不变量。
- 真实大表索引构建/锁时长、EXPLAIN ANALYZE 与生产规模扫描吞吐、积压恢复速度、24 小时内的容量保障，以及目标 Outbox 历史保留副本。
- 真实 EventBridge 每分钟触发、重试/DLQ 投递、CloudWatch 告警、Lambda IAM/网络、AWS IoT/SQS 与真机乱序/重复。
- 目标库连接或迁移、资源部署、Git 推送、全仓 verify/页面 E2E、正式目标 Gate、IMG-13 evidenceImage 读取权限。

G2 继续 PARTIAL：IMG-09～12 本地迁移、会话、登记、解析与调度接线完成；IMG-13 和目标流程证据待完成。拍照白名单、设备规模和首帧等待目标仍 OPEN。

下一可执行任务为 IMG-13：扩展告警详情与事件查询的 evidenceImage，落实源记录读取权限和 media:read 双重校验，区分无权限省略、未 LINKED 返回 null、关联媒体 AVAILABLE/DELETED，并补齐跨租户、告警清除后读取和删除后展示测试。

## 复现命令

本机 pnpm 为 `/opt/homebrew/bin/pnpm` 10.20.0，Node 24.22.1。以下 pnpm 指该绝对路径。

```sh
pnpm exec vitest run apps/ingestion-worker/test/media-evidence-resolution.test.ts apps/ingestion-worker/test/media-evidence-entry.test.ts apps/ingestion-worker/test/media-evidence.test.ts --maxWorkers=4
pnpm exec vitest run apps/cloud-api/test packages/database/test packages/aws-clients/test apps/ingestion-worker/test apps/summary-worker/test infra/test --maxWorkers=4
pnpm --filter @fdp/cloud-api... typecheck
pnpm --filter @fdp/ingestion-worker typecheck
pnpm --filter @fdp/summary-worker typecheck
pnpm --filter @fdp/infra typecheck
pnpm --filter @fdp/cloud-api... build
pnpm --filter @fdp/ingestion-worker build
pnpm --filter @fdp/summary-worker build
pnpm --filter @fdp/infra build
pnpm test:contracts
pnpm openapi:check
node --import tsx --test scripts/check-delivered-runtime.test.mjs scripts/check-migrations.test.mjs scripts/check-cdk-synth.test.mjs
node scripts/check-migrations.mjs
node scripts/check-boundaries.mjs
node scripts/check-sensitive-sinks.mjs
node scripts/check-secrets.mjs
node --import tsx scripts/check-delivered-runtime.mjs
PATH=/opt/homebrew/bin:$PATH AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-1 node scripts/check-cdk-synth.mjs
```

另对全部本批 TS/MJS 修改文件运行 ESLint/Prettier，并执行 git diff --check。没有执行 deploy、目标 prisma migrate 或 push。
