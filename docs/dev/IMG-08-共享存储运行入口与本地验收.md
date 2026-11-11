# IMG-08 共享存储、运行入口与本地验收

本文记录 IMG-08 原交付及其验收口径。DEC-009@2.1.0 后，生产预览准入和权威写入均已解除对白名单的依赖，当前规则见 [DEC-009 更新记录](../../contracts/decisions/changes/DEC-009-upgrade-2.1.0.md)。

2026-11-06，基于本地提交 `cb8ddcdb` 实施 IMG-08。初始分支为 main，工作区干净，已有四个未推送提交。本批只交付本地实现、迁移文件、IaC 定义及验证，不执行部署、迁移到目标库或 Git 推送。

依据为[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、[P0 存储并发设计](./IMG-03-图片预览临时存储与并发设计.md)及 IMG-05～IMG-07 已有服务。刷新、租约、帧有效期、去重与限频数值均沿用冻结策略。

## 交付范围与文件

| 文件或文件组 | 本批职责 |
|---|---|
| `packages/domain/src/live-image-storage.ts`、domain/index、cloud-api/live-image/storage/index | 将无鉴权依赖的共享存储类型下沉到领域包，保留原应用导入兼容，无共享包反向依赖应用 |
| `packages/aws-clients/src/live-image-dynamodb.ts`、index、package.json、pnpm-lock.yaml | DynamoDB SDK 适配器、强一致/事务读取、条件写、三记录原子提交、有限 I/O、懒初始化；新增 DynamoDB SDK 及工作区依赖 |
| `packages/database/src/live-image-authority.ts`、`live-image-io.ts`、index | 共享/排他锁、写入拦截、惰性 Prisma 查询、数组事务、嵌套事务复用及授权 I/O 生命周期 |
| `packages/aws-clients/src/live-image-authority.ts` | 权威变更前失效、按影响范围封闭、提交后版本核验与恢复、固定恢复日志、生产 Prisma 工厂 |
| `apps/cloud-api/src/live-image/postgres-authorization.ts` | 持锁刷新用户、角色、客户范围、证书、设备状态与服务端白名单 |
| `packages/database/prisma/schema.prisma`、`migrations/20261106000000_live_image_policy/` | 服务端预览白名单表及当前 Schema SHA-256，不改历史媒体表 |
| cloud-api 的 `runtime/device-entry.ts`、`lambda-entry.ts`、`device-lambda.ts`、`admin-lambda.ts`、`admin-cors.ts`，admin/onboarding/handler.ts | 五接口的组合根、原始请求体、参数、响应头、204、CORS 和依赖失败响应 |
| cloud-api、ingestion-worker、summary-worker 的全部 18 个数据库运行组合根 | 全部使用共享权威写入工厂；管理员预连接候选保留原 client，并在外层安装相同拦截器 |
| `runtime/delivered-operations.ts`、REST delivered manifest、live-image-api、OpenAPI bundle、runtime gate 测试 | 五接口从 planned 转为 implemented，本地生产入口事实表与 134 个操作双向一致 |
| `infra/src/stacks/app-dependencies-stack.ts` | 两张 DynamoDB 表、TTL、加密、CONTROL 保留/PITR、环境变量、最小权限和私有子网 Gateway Endpoint |
| observability/redaction、database/audit | imageBase64/jpeg_base64 字段脱敏；新增代码不输出图像体、原始请求或原始存储错误 |
| `live-image-postgres.test.ts`、`live-image-runtime.test.ts`、aws-clients/live-image-dynamodb.test.ts、infra/live-image-wiring.test.ts | 鉴权与协议集成、五路由串联、SDK 命令边界、超时、IAM 和资源断言 |
| `onboarding-serial-migration.test.ts` | 历史迁移测试按实际位置读取前置 SQL，取消“该历史迁移永远最后”的假设，保留历史冲突和回滚断言 |

## DynamoDB 的实际结构和原子边界

使用同一区域两张表，均为 `pk = DEVICE#<deviceId>`、`sk` 复合主键。分表是 IMG-03 逻辑模型的物理细化，使后台写入任务只能访问授权控制项，无法读取 JPEG。没有跨区域复制、GSI、Redis、进程内状态或失败降级缓存。

| 表 | SK | 保留及读取 |
|---|---|---|
| LIVE_IMAGE_CONTROL_TABLE | CONTROL | 无 TTL；revision/authEpoch 永久单调保留；强一致 GetItem |
| LIVE_IMAGE_PAYLOAD_TABLE | FRAME | 每设备最新帧；ttl 只用于物理清扫，逻辑可见性仍最长 10 秒 |
| LIVE_IMAGE_PAYLOAD_TABLE | DEDUP#streamId#frameId | 摘要 15 秒逻辑有效；保留原 receivedAt/expiresAt，不包含 JPEG |

CONTROL 的 JSON payload 保存领域完整结构；revision、authEpoch、customerId、enabled、streamId、activeUntilMs、latestCapturedAtMs、lastNewFrameAtMs 同步保存为条件字段。CAS 同时检查 revision 和 authEpoch，首次创建要求不存在。替换必须 revision 加一且 epoch 不倒退，CONTROL 不提供 Delete 权限。

上传快照一次 TransactGetItems 读取 CONTROL/DEDUP；最新帧一次事务读取 CONTROL/FRAME，跨两张表仍是同一次事务快照。发布通过单次 TransactWriteItems 写 CONTROL、FRAME、DEDUP。CONTROL 条件同时核对版本、授权代次、客户、流、能力、未到期查看者、采集水位和每设备 1000ms 限频；去重项要求不存在或摘要逻辑过期。最后释放、换流、其他新帧和失效都修改同一个 CONTROL，因此旧版本上传不能绕过这些变化。

适配器在提交时重取时钟，将 I/O 截止限制为租约、帧截止及授权锁期限的较早值。SDK 只尝试一次，每次默认最多 1000ms；服务层保留既有五次条件竞争重读策略。只有明确的条件冲突返回 false；限流、权限、参数、传输和不明事务失败均抛错，由预览 Handler 返回安全的 503。已超时的写入结果可能未知；客户端只能在原 stream/帧标识下重试，服务重新鉴权并按摘要判断，不得假设未写入。

检查序列化记录大小，使用 380 KiB 的保守边界，正常 128 KiB JPEG 对应的 Base64 记录远小于它。读取拒绝损坏的控制、帧和摘要记录，不从不完整快照拼接结果。物理 TTL 延迟不扩大可见窗口。

事务与 IAM 按 AWS 原生 API 处理：事务内 Put/Get 分别需要对应表的 PutItem/GetItem 权限。参考 [AWS 事务 IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)和[事务隔离](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)。这些资料核对不等于真实 AWS 验证。

## PostgreSQL 持锁鉴权和写入口协议

预览请求先开数据库事务，取得固定的共享 advisory 屏障，再取设备/用户 FOR SHARE 行锁，保持到 DDB 操作完成并提交事务。设备身份只取 Gateway mTLS 上下文，锁内重新验证登记指纹、证书 ACTIVE/撤销/有效期/轮换截止及设备。管理员 JWT 只提供经验证主体；锁内按 cognitoSub 读取 ACTIVE 用户及当前 UserRole/UserScope，重建角色与客户范围，拒绝未知、混合角色和不唯一的客户范围，再校验 media:read 和设备可见性。旧 JWT 中的权限或客户值不能替代这些查询。

P0 用全局共享/排他 advisory 屏障覆盖权限关系和多设备变更，避免各写入口锁顺序不一致。配置了共享表的生产客户端在业务事务开始时先取得排他屏障，相关设备还取 FOR UPDATE 行锁；单条根客户端写入也包入事务。这个策略会串行化业务写事务，是明确的 P0 实现取舍，真实负载、锁等待与连接池预算必须在目标环境验收，不能由本地结果推定容量通过。

DDB 失效按影响范围执行：设备/运行状态/证书/白名单定位对应设备，客户与站点定位其设备，用户/角色分配/范围变更定位含该主体租约的流。未知原始 SQL、关系嵌套写或角色定义变更采取保守的白名单设备集合失效。普通 Heartbeat 的相同 operationalStatus、证书领取/验证记账、与权限无关的资料更新不清流。原有两条 auth_rate_limits 原始计数 SQL 以完整固定语句白名单排除；其他原始写默认参加失效。只检查 Prisma 写入封装，不把业务 JSON 中同名字段识别成关系更新。

权威写入顺序：

1. 获取排他屏障和相应设备锁，读取当前 CONTROL。
2. 条件递增 revision/authEpoch，enabled=false，清查看者、streamId 和采集水位，保留设备级 lastNewFrameAtMs。
3. 执行业务 SQL。DDB 失败则 SQL 不得提交；SQL 回滚时不撤销 DDB 关闭状态。
4. SQL 成功提交后，在新的排他事务内重新检查设备归属、生命周期、运行状态及白名单。只有 CONTROL 仍是本事务留下的关闭版本，才允许用新代次恢复；恢复也没有旧租约和旧流。
5. 后续写入留下的新关闭版本不能被较早事务恢复。提交后恢复失败，业务 SQL 的成功响应仍保留，预览保持关闭，发出固定脱敏信号 `live-image.authority.recheck-required`，由受信操作显式复核恢复。不得把已提交业务 SQL 描述成回滚或盲目重试业务动作。

写入代理保留惰性查询和数组事务的原子性；嵌套服务及权威变更回调复用当前事务，避免根 client 在回调中另开事务。预览读事务通过受控辅助函数使用原 client 开共享事务，避免被写屏障升级。直接另建未包装 client、绕过应用执行权威 SQL、混用旧部署版本均不属于该协议允许的运行方式。

锁等待 1000ms，预览/恢复事务最多 10000ms。AsyncLocalStorage 将外部 I/O 生命周期限制为数据库事务预算的 80%，嵌套操作不能延长父预算。事务结束/失败会中止其信号；SDK 提交前与返回后都检查生命周期。迟到读取不能返回图片，超时回调不能重新读取新 CONTROL 后按旧权限申请租约；已发出写请求的迟到提交仍受 CONTROL 版本条件约束。

## 白名单启用、关闭和恢复

新增 `device_live_image_policies(device_id PK/FK, enabled DEFAULT false)`；迁移不填任何设备，不改 Configuration V1，不启用旧设备。设备本地仍须支持 live-image-v1 并显式 opt-in。

受信内部操作使用已包装的 Prisma client，按单个设备执行以下形式的 upsert（示意，本批未执行）：

```ts
const client = createPreviewAwarePrismaClient(databaseUrl);
await client.deviceLiveImagePolicy.upsert({
  where: { deviceId },
  create: { deviceId, enabled: true },
  update: { enabled: true },
});
```

环境须有两个表名；该操作自动先关闭 CONTROL，提交后重新检查准入才恢复。置 false 则关闭，缺行等同未启用。回滚、失效恢复失败或版本竞争后的显式恢复也使用这一入口，不直接修改 DynamoDB、不倒退 epoch、不从旧快照补回租约。批量启用应逐设备执行同一入口，不以裸 SQL/createMany 代替。

未来上线须先应用向前兼容的白名单迁移、创建资源及权限，并更新全部 18 个数据库 Lambda，确认旧版本流量和在途后台任务已排空，最后才允许服务端和设备端 opt-in。白名单保持空时可以验证旧设备链路；不得在新旧权威写入口混跑时启用预览。本批未执行上述目标环境步骤。

## 五接口及运行接线

| 方法及路径 | 运行入口 |
|---|---|
| PUT /api/v1/admin/devices/{deviceId}/live-image/viewers/{viewerId} | admin Lambda，当前 JWT 主体 + PostgreSQL 鉴权 + CONTROL CAS |
| DELETE 同一路径 | admin Lambda，只释放自身查看租约，204 空响应体 |
| GET /api/v1/device/live-image/state | device Lambda，Gateway mTLS + PostgreSQL 当前证书/设备 |
| POST /api/v1/device/live-image/frames | device Lambda，原始 JSON 字符串送现有校验服务，先限 180 KiB 再 JSON 解析 |
| GET /api/v1/admin/devices/{deviceId}/live-image/latest | admin Lambda，当前用户租约 + CONTROL/FRAME 事务快照 |

复用既有 API Gateway proxy、Cognito 和 mTLS 域名定义。未信任事件顶层 actor/identity。所有预览业务、鉴权、解析和依赖失败响应均 no-store；管理员响应头传递到 Lambda/CORS，429 暴露 Retry-After；冷启动/账户依赖故障给出安全 503。预检仍在 Secret/数据库初始化前处理，只有精确配置 Origin 获 CORS 许可。缺少表配置时旧路由仍可初始化，预览请求失败关闭，绝不创建本地存储替代。

两表均按需计费并加密。CONTROL 设置 RETAIN/PITR、无 TTL；FRAME/DEDUP 表设置 ttl。18 个数据库 Lambda 只有 CONTROL GetItem/PutItem；admin 另有 payload GetItem，device API 另有 payload GetItem/PutItem，其他后台任务无图片表访问权。私有 Lambda 子网增加 DynamoDB Gateway Endpoint。既有 API 日志不启用请求体 tracing，新恢复信号经脱敏 logger 输出。

REST 文件的 implemented 表示源码与运行路由已交付，未表示云端已上线。wire schema、策略参数、版本 0.16.0 与生成 image-types 不变；完整契约检查验证冻结基线和旧请求兼容。

## 本地检查和证据边界

本地命令与结果如下。所有 AWS 适配器测试使用本地注入 transport，PostgreSQL 使用应用全部迁移的 PGlite；没有真实云服务或生产凭据验收。

| 检查 | 最终结果 |
|---|---|
| cloud-api 全部测试 + aws-clients + DB-02/事务观测 + observability，maxWorkers=4 | PASS，97 文件、859 项 |
| ingestion-worker + summary-worker 全部测试，maxWorkers=4 | PASS，24 文件、154 项 |
| IMG-08 IaC 资源、18 个入口及权限断言 | PASS，4/4，已按当前代码复验 |
| contracts 全套 | PASS，319/319，冻结基线、样例及旧请求兼容均通过 |
| delivered runtime + migration 脚本测试 | PASS，11/11；34 份契约、134 操作双向一致 |
| cloud-api/database/aws-clients/infra 及相关包类型、构建 | PASS，含 auth/domain/media/observability、ingestion-worker/summary-worker |
| OpenAPI bundle/lint、迁移结构和实际漂移、边界、脱敏 sink、secret、格式、diff | PASS；定向 ESLint/Prettier 通过 |
| 从当前源码重建 infra 后 CDK synth | PASS，无 warning；已交付 Lambda asset 和既有 CMD/OTA Gate 通过，包含新增两张表 |

覆盖包括：服务端缺省关闭/显式恢复、JWT 旧权限/客户失效、账号状态、证书撤销、分配/挂起/退役、失效先于 SQL、回滚保持关闭、提交后恢复失败、新版本关闭不可被旧事务重开、数组事务和回调复用、跨设备失效隔离、普通 JSON 不触发关系写识别、现有计数器和 Heartbeat 兼容、SDK 条件/三项原子命令/快照/大小/异常分类，以及事务超时、忽略中止的迟到 I/O 和脱离事务回调。

五接口本地串联使用经签名 JWT、PGlite 实际鉴权、Gateway 形状的 mTLS 身份及本地共享存储端口：申请租约 → state ACTIVE → 样例 JPEG 上传 → READY → UNCHANGED → 释放 204 → latest 409/state IDLE，再验证权限撤销后 403。该证据不等于真实 TLS 握手、真实 DynamoDB 隔离或公开域名验收。原有 IMG-05～07 并发与授权失效测试全部保留。

### 执行中 FAIL / 中断保留

| 首次失败或中断 | 处置与状态 |
|---|---|
| 依赖下载初次 DNS ENOTFOUND | 网络权限下重试安装成功，之后 frozen-lockfile 离线安装通过；RESOLVED |
| 类型检查：operationalStatus 可空、旧 dist 缺新导出、测试 JWT 参数、SDK 可选字段断言和动态 undefined 测试边界 | 类型与样例修正并按依赖顺序构建；RESOLVED |
| PGlite 用例违反 device/customer 既有约束 | 补全测试归属，保留生产约束；RESOLVED |
| Migration 漂移：FK 缺 ON UPDATE CASCADE | 对齐 Prisma 外键定义；RESOLVED |
| runtime gate 清单数量仍为 33 | 改为 34 份 / 134 操作，补齐负向验证；RESOLVED |
| logger 预绑定导致测试 spy 未捕获恢复信号 | 恢复路径使用即时脱敏 logger，并验证信号不含原始错误；RESOLVED |
| 全 cloud-api 回归暴露历史迁移 endsWith 假设 | 改为定位指定迁移之前的 SQL，原历史回滚断言不变；RESOLVED |
| 定向格式初检有 8 个文件未格式化 | 按仓库 Prettier 格式化后复验；RESOLVED |
| 首次 CDK CLI 检查未结束，另一次使用了旧 infra/dist | 终止挂起检查；旧产物结果不纳入最终验收。重建当前源码并使用 /opt/homebrew/bin 优先 PATH、禁用元数据与本地凭据配置查询后重跑；最终结果单独记录 |

最终未解决 FAIL=0、BLOCKED=0；历史失败与中断如上保留，目标环境 NOT_RUN 不计为 PASS。

### NOT_RUN / OPEN

- **NOT_RUN**：真实 DynamoDB 条件表达式执行、跨实例事务竞争/超时未知结果、TTL 清扫、吞吐、延迟和成本；本地 SDK 命令断言不证明 AWS 服务实现。
- **NOT_RUN**：真实多连接 PostgreSQL 的共享/排他锁竞争、死锁/超时和池容量；PGlite 单后端只能验证 SQL、事务和排队路径，不能证明原生多会话锁表现。
- **NOT_RUN**：资源部署、目标库迁移、18 个 Lambda 同版本切换与旧执行排空、公开域名 Cognito/mTLS/CORS/IAM 实测、真实证书链、设备和浏览器真机。
- **NOT_RUN**：全仓库 verify、admin-web E2E、全部 IaC 测试及后续 S3 触发留档/图片关联功能；本批执行范围以列出的命令为准。
- **OPEN**：事件/告警拍照白名单、启用设备规模、首帧等待目标；不得擅填数值。全局写屏障的容量影响和并发写入导致关闭后的恢复要求，须纳入目标验收后才能启用白名单。

G0 维持原 PASS。IMG-08 本地实现完成后，IMG-05～08 本地后端就绪；G1 仍为 PARTIAL，待真实共享存储及多会话鉴权竞争证据，不将本地串联升格为目标 Gate。G2～G5 不变。

下一可执行任务：IMG-09，按已确认迁移设计实现 triggerRef、不可变文件申报、关联状态及唯一约束，并验证无 triggerRef 的历史会话和媒体兼容。IMG-08 白名单迁移与该归档迁移独立；云端启用仍须上述待验收项和部署授权。

## 检查复现命令

pnpm 使用仓库版本 10.20.0，本机调用 /opt/homebrew/bin/pnpm。其余检查按下列命令执行；对本次修改和新增的 TS/MJS 文件运行 ESLint，对支持的修改文件运行 Prettier check，并执行 git diff --check。

```sh
pnpm exec vitest run apps/cloud-api/test packages/aws-clients/test packages/database/test/db02.test.ts packages/database/test/transaction-observation.test.ts packages/observability/test --maxWorkers=4
pnpm exec vitest run apps/ingestion-worker/test apps/summary-worker/test --maxWorkers=4
pnpm exec vitest run infra/test/live-image-wiring.test.ts
node --import tsx --test scripts/check-delivered-runtime.test.mjs scripts/check-migrations.test.mjs
pnpm --filter @fdp/cloud-api... typecheck
pnpm --filter @fdp/ingestion-worker typecheck
pnpm --filter @fdp/summary-worker typecheck
pnpm --filter @fdp/infra typecheck
pnpm --filter @fdp/cloud-api... build
pnpm --filter @fdp/ingestion-worker build
pnpm --filter @fdp/summary-worker build
pnpm --filter @fdp/infra build
pnpm openapi:check
pnpm test:contracts
node scripts/check-migrations.mjs
node scripts/check-boundaries.mjs
node scripts/check-sensitive-sinks.mjs
node scripts/check-secrets.mjs
node --import tsx scripts/check-delivered-runtime.mjs
# 先从当前源码构建；禁用本地凭据配置与 EC2 元数据查询。只 synth，不 deploy。
AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-1 node scripts/check-cdk-synth.mjs
```
