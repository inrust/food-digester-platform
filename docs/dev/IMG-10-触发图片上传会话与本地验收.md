# IMG-10 触发图片上传会话与本地验收

2026-11-06，基于本地提交 `0bbd1849` 实施。初始分支 main，工作区干净，已有六个未推送提交。本批不部署、不连接或迁移目标库、不推送；数据库结构沿用 IMG-09，没有新增迁移。

实施依据为[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、[触发引用设计](./IMG-04-图片触发引用迁移设计.md)和[IMG-09 验收](./IMG-09-图片触发引用迁移与本地验收.md)。本批完成会话业务，图片登记/Evidence/receipt/Outbox 同事务及关联解析仍属于 IMG-11～13。

## 修改文件

| 文件 | 职责 |
|---|---|
| `apps/cloud-api/src/media/upload-session.ts` | 新建上传会话引擎、严格触发引用解析、锁内身份与归属重验、不可变申报、重用/新办/冲突/已登记、UTC 配额和签名结果封装 |
| `media/service.ts` | 将会话实现移入独立文件并保留原导出、DTO 和返回 view 的 service 兼容入口；管理员列表/下载不变 |
| `media/device-handler.ts`、`media/errors.ts` | 接受可选 triggerRef，选择 200/201，返回两个局部 409 错误及已登记 mediaId，错误脱敏 |
| `packages/aws-clients/src/s3-media-url-signer.ts` | TTL 和 signingDate 使用同一时点，防止凭据解析延迟使实际签名截止超过原期限 |
| `apps/cloud-api/test/media-trigger-sessions.test.ts` | 41 项 triggerRef、配额竞争、重用、过期、登记、回滚、失败恢复、跨租户与授权失效测试 |
| `media-migration-compatibility.test.ts` | 新创建的旧格式请求现在保存已知精确字节；历史记录和跨迁移在途会话继续保留 NULL |
| `packages/aws-clients/test/s3-media-url-signer.test.ts` | 增加实际离线 SigV4 URL 截止及签名头测试，使用本地静态测试凭据，不发送 S3 请求 |
| `contracts/rest/device-media-api.json`、`openapi.bundle.json` | IMG-10 extension 元数据改为 implemented，更新 bundle 源摘要；不改变 wire schema、版本和基线 |
| 本文、开发计划、IMG-04 实施补充 | 更新阶段状态、锁顺序、恢复边界、检查与 NOT_RUN |

## 请求与响应

继续使用 `POST /api/v1/device/media/upload-sessions` 和 Gateway mTLS。省略 triggerRef 的旧 IMAGE/VIDEO 请求仍每次新建并返回 201，响应不增加 triggerRef。旧请求与新请求共享每设备 UTC 日配额，生产策略仍为 100 次新签发/日、900 秒 URL，IMAGE 10 MiB、VIDEO 200 MiB。

triggerRef 必须是仅含 kind/messageId 的对象；kind 为 EVENT/ALARM，messageId 符合原契约 ASCII 格式且最多 128 字符，逐字符区分大小写。仅 IMAGE 可携带，null、数组、未知键、错误类型、VIDEO 引用及客户端指定 Customer/device/objectPath 都拒绝。文件大小、精确字节、KB 一致性、文件名和 SHA-256 仍按既有策略校验。

| 条件 | 返回 |
|---|---|
| 首次接受该触发引用及申报 | 201，原会话结构加 triggerRef |
| 同 Customer/device/kind/messageId，申报完全一致，ISSUED 会话未到期 | 200，原 sessionId、key、createdAt、expiry 和精确字节，重签 URL，不计新配额 |
| 同引用的合法文件申报改变（文件名、字节数、KB 或 Hash） | 409 MEDIA_TRIGGER_CONFLICT，无 mediaId |
| 同申报且图片已经登记 | 409 MEDIA_ALREADY_REGISTERED，error.details.mediaId；不新建、不签名、不计配额 |
| 未登记、原尝试到期、当天仍有配额 | 先置旧行为 EXPIRED，再新建 201；新 sessionId/key，保留原 Trigger 申报，计一个新配额 |
| 当天无新签发额度 | 原有 409 CONFLICT；有效会话重用和已登记判定优先于额度检查 |
| COMPLETED 会话缺 MediaObject，或依赖/签名异常 | 安全 500，失败关闭，不猜测登记完成或另造会话 |

Hash 先规范为小写 hex 再比较，文件名与 messageId 不改大小写。申报冲突判定先于已登记回复，改变申报不会得到原 mediaId。所有成功及失败响应通过实际 OpenAPI 校验；新增错误只属于该 operation 的局部扩展，没有改全局 CT-05 错误目录。

## 事务与并发边界

HTTP Handler 首次 mTLS 验证后，将可信身份传给会话引擎。引擎只接受根客户端，避免在未提交的外层事务中签发 URL。生产继续使用 IMG-08 包装的 Prisma 客户端，参加权威写入屏障。

事务内依次：

1. 对设备行 FOR UPDATE，重新验证当前证书、有效期、撤销/轮换状态、设备生命周期及 Customer。初次认证后等待期间发生撤销、挂起、退役或分配变化，均不允许签名或重用旧会话。
2. 在当前 Customer/device 下查找或新建 MediaTrigger，并用 FOR NO KEY UPDATE 串行化该触发的请求。该锁允许元数据登记所需的 KEY SHARE 读取，避免用更强行锁与既有登记路径形成不必要的循环等待，锁兼容性已核对 [PostgreSQL 16 行锁文档](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS)。申报创建后由 IMG-09 SQL 约束保持不可变。
3. 锁定该触发的会话，再检查 MediaObject 登记事实。登记事实不依赖 Evidence 是否已创建，因此在 IMG-11 尚未接入前，已经完成登记的图片也不会被再次签发。媒体已软删除仍属于已登记，不会重新拍摄替代原文件。
4. 在锁后重取时钟。有效 ISSUED 返回原行；到期则在同一事务内改 EXPIRED，再检查 UTC 窗口并创建新行。唯一索引继续兜底单 ISSUED，所有会话状态都计入其创建 UTC 日的新签发额度，不因重用、过期或换客户清零。
5. 创建/重用审计与对应事务一起提交。仅新建记录产生 `media.upload_session.create` SUCCESS，重用记录为 `media.upload_session.reuse`。失败写审计不包含原始错误、签名 URL 或请求本体，审计本身失败也不掩盖原业务错误。

配额与过期更新在同一事务；配额不足或事务内审计失败时，EXPIRED 改动和新建行全部回滚，没有孤立 Trigger 或额外配额。被回滚的旧行可能仍显示 ISSUED，但其时间已经到期，不会再次作为有效 URL 返回。到新 UTC 日后，可以在原不可变申报下新办。

UTC 时间在拿锁后计算，等待跨日不会错用入队前的日窗口。跨日仍有效的原会话直接重用；即使新日额度已耗尽，也不重复领取额度。客户端时间与 MQTT 时间不决定上传配额。

## 签名期限及恢复

数据库提交后才签名。key、Content-Length、SHA-256 和 expiresAt 均来自已选中的数据库行，不使用重试请求替换申报。S3 SDK 显式设置 signingDate，并以同一时点向下取整剩余秒数；离线真实 SigV4 测试解析 X-Amz-Date/X-Amz-Expires，验证延迟解析凭据和再次签名均不会超过原绝对截止。长度及 SHA-256 checksum 的签名约束保留。

响应前再次检查期限，签名期间已经到期则不返回过期 URL。AWS 签名器不能为不足一整秒的剩余时间生成符合本实现约束的 URL，该窗口可能返回安全 500，不能借此提前延长期限；原会话到期后才可新办。

签名失败发生在会话已提交后，该尝试仍占一个配额，创建审计反映已持久化事实；另记录签名失败。相同申报重试取得该会话并返回 200，不重复签发或领取额度；若确已到期则遵循新办规则。

授权与登记回复以持锁查询点判定，签名在事务外执行。在查询点前已经提交的登记返回已登记；之后发生的变化不宣称能撤回已授权的在途响应或已签出的 S3 URL。后续新请求必须重新验证并读取当前状态。

## 旧请求及历史数据

原导出 `createMediaUploadSession` 继续返回 view；HTTP 使用新增的 `createMediaUploadSessionOutcome` 明确区分状态。所有 HTTP 请求都传 mTLS 身份并在锁内二次验证；直接使用旧 service 兼容入口的受信调用者仍须遵守 AUTH-03 上下文约定。

本批对新创建的会话写入已经知道的精确 sizeBytes，包括不带 triggerRef 的新请求。没有回填、改写历史 NULL；IMG-09 的历史夹具、迁移前已签发会话及无 Hash/字节数历史媒体继续按原行为读取、登记或下载。旧请求的重复调用仍是两个 201，而非被新 triggerRef 幂等逻辑合并。

本批没有修改媒体登记核心、清理对象、Evidence、receipt 或 Outbox。未来上线必须等 IMG-11 配齐同事务登记，并协调支持 triggerId 的消费者；当前本地会话测试不能替代整条 S3/消息链路验收。

## 本地检查

| 检查 | 结果 |
|---|---|
| triggerRef 会话专项 | PASS，41 项 |
| 新专项、原 Media、历史兼容与签名器 | PASS，4 文件、59 项 |
| cloud-api、database、aws-clients、ingestion-worker、summary-worker 全部回归，maxWorkers=4 | PASS，139 文件、1245 项 |
| contracts 全套 | PASS，319 项；旧请求与冻结基线兼容 |
| runtime 与 migration 脚本测试 | PASS，11 项；134 操作保持一致 |
| cloud-api 及依赖、worker 类型和构建 | PASS；最终源码审计字段补回后定向复验 |
| OpenAPI、迁移漂移、边界、脱敏 sink、secret | PASS |
| 当前产物 CDK synth | PASS，无 warning；已交付 Lambda asset 与既有 CMD/OTA 接线检查通过，未部署 |
| 定向 Prettier/ESLint、git diff --check | PASS |

测试使用全部迁移后的隔离 PGlite、已有 JPEG 样例、内存对象存储和签名替身。S3 签名器另用离线静态测试凭据生成真实 SigV4 URL，不发送 HTTP 到 S3。并发覆盖相同/不同触发最后一个配额、申报竞争、多个过期重试、原请求共用额度、跨 UTC 日、注册先提交、事务回滚、授权变化及生产权威写入包装器。

本轮检查未解决 FAIL=0、BLOCKED=0；测试主动注入的签名和审计异常属于预期负向用例，未通过删除断言绕过。NOT_RUN 不计为 PASS。

### NOT_RUN

- 原生 PostgreSQL 多会话的设备/Trigger/会话行锁竞争、死锁和超时，以及真实负载和连接池预算；PGlite 单后端的并发调用不能升级为这些证据。
- 真实 S3 PUT、签名头服务端强制、临时凭据到期、对象大小/Hash实测、公开域名 mTLS、真实设备与浏览器。
- IMG-11 同事务登记/Evidence/receipt/Outbox、IMG-12 重试/解析和 IMG-13 查询权限；本批“已登记”只确认 MediaObject 事实，不代表来源关联成功。
- 目标库连接或迁移、资源部署、Git 推送、真实历史数据副本、全部仓库 verify/页面 E2E、正式目标 Gate。

G2 继续 PARTIAL，等待 IMG-11～13 和目标流程。事件/告警拍照白名单、设备规模和首帧目标仍 OPEN。下一任务为 IMG-11：统一登记端锁顺序，使用持久化精确字节和 Hash 校验，在同一事务提交会话完成、MediaObject、PENDING Evidence、receipt 和 Outbox，并验证旧/新会话与重复 MQTT 的竞争。

## 主要复现命令

本机 pnpm 使用 /opt/homebrew/bin/pnpm 10.20.0，Node 24.22.1。

```sh
pnpm exec vitest run apps/cloud-api/test/media-trigger-sessions.test.ts apps/cloud-api/test/media.test.ts apps/cloud-api/test/media-migration-compatibility.test.ts packages/aws-clients/test/s3-media-url-signer.test.ts
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
AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-1 node scripts/check-cdk-synth.mjs
```

另外对全部本批 TS 文件运行 ESLint，对支持的改动文件运行 Prettier check，并执行 git diff --check。未运行 deploy、prisma migrate deploy 或推送命令。
