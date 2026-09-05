# IAC-01 应用依赖 CDK Stack

数据源：[infra/src](../infra/src)；模板断言测试：[infra/test](../infra/test)；App 入口：[infra/src/app.ts](../infra/src/app.ts)；Stack：[app-dependencies-stack.ts](../infra/src/stacks/app-dependencies-stack.ts)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | IAC-01（P0 / 基础设施代码），依赖 ENG-01、DB-01、CT-02 |
| Stack | 单一 `AppDependencies`（物理名 `fdp-{env}-app`），按领域分 section 组织 |
| Topic 事实源 | `contracts/mqtt/topic-catalog.json`（CT-02）；一致性由 `test/topic-catalog-parity.test.ts` 强制 |
| 数据库引擎 | PostgreSQL 16（全库统一选型：DB-01 Prisma provider、btree_gist 排他约束与方案文档均已统一为 PostgreSQL） |
| 三类 API 入口 | 《AWS 云端方案关键问题与解决方案》§4.3 独立入口决策 |

功能边界（明确不做）：生产 Multi-AZ、备份、告警、Dashboard、Budget、WAF、扩缩容和发布流水线。

## 2. 资源清单

| 域 | 资源 | 命名（env=test 示例） |
|---|---|---|
| KMS | 应用数据 Key、证书包信封加密 Key（均启用轮换） | `alias/fdp-test-data`、`alias/fdp-test-cert-package` |
| SQS | Ingress + DLQ、Archive + DLQ、Quarantine、IoT Rule Error | `fdp-test-ingress` 等 6 队列，KMS 加密；主队列 maxReceiveCount=5 |
| IoT | 8 个 TopicRule（8 上行 Topic → Ingress SQS，Error Action → 独立错误队列） | `fdp_test_iot_{type}`（IoT 命名仅允许 `[A-Za-z0-9_]`） |
| Lambda | ingestion / archive / outbox-publisher / summary / api（各配独立执行角色） | `fdp-test-{name}`，Node.js 24 / ARM64，占位 Handler 由 BE 任务替换 |
| 调度 | EventBridge Rule：outbox-publisher 每 1 分钟、summary 每 1 小时 | `fdp-test-outbox-publisher`、`fdp-test-summary` |
| VPC/RDS | 2 AZ、3 类子网、单 NAT；RDS PostgreSQL 16 `db.t4g.micro` 位于隔离子网 | `fdp-test-vpc`、`fdp-test-db` |
| Secrets Manager | RDS 凭据自动生成（KMS 加密），口令以动态引用注入实例 | `fdp-test-rds-credentials` |
| S3 | Raw / OTA / Media / Export / mTLS truststore | `fdp-test-{purpose}-{accountId}`，全部阻断公网 + TLS 强制 + Versioning + KMS |
| API Gateway | Onboarding（Token，限流）、Device（mTLS 自定义域名）、Admin（Cognito JWT + Internal IAM） | `fdp-test-{onboarding,device,admin}-api` |
| Cognito | User Pool（邮箱登录、OTP MFA OPTIONAL、12 位密码策略、`custom:customer_id`）、Admin Web Client、5 个 RBAC 组（DEC-012） | `fdp-test-admin` |

## 3. 三类 API 认证入口分离

| 入口 | RestApi | 认证机制 | 路径 |
|---|---|---|---|
| Onboarding | `fdp-{env}-onboarding-api` | 一次性 Token（网关层 NONE，应用层 AUTH-02 校验） | `/api/v1/device/*` |
| Device | `fdp-{env}-device-api` | X.509 mTLS（自定义域名 truststore；AUTH-03 应用层白名单） | `/api/v1/device/*` |
| Admin | `fdp-{env}-admin-api` | Cognito JWT（`/admin`、`/customer`）；IAM SigV4（`/internal`） | `/api/v1/{admin,customer,internal}/*` |

- mTLS 自定义域名由 context 注入：`cdk synth -c deviceApiDomainName=... -c deviceApiCertificateArn=... [-c deviceApiTruststoreKey=...]`；三项成对出现，缺省时不创建域名、保留默认 execute-api 入口（供开发过渡）；提供域名后自动 `DisableExecuteApiEndpoint`。
- truststore CA bundle 由环境流程上传到 `fdp-{env}-mtls-truststore-{accountId}` Bucket（本任务不内置任何真实 CA 材料）。
- 三个入口共享同一 API Lambda（模块化单体原则），隔离在网关认证层。

## 4. 应用配置输出

- **Lambda 环境变量**：`DB_SECRET_ARN`、`USER_POOL_ID/CLIENT_ID`、`RAW/OTA/MEDIA/EXPORT_BUCKET_NAME`、`INGRESS/ARCHIVE/QUARANTINE_QUEUE_URL`、`CERT_PACKAGE_KEY_ARN`、`ENV_NAME` 等，按 Worker 最小需求分配；
- **CfnOutput**：三个 API URL、User Pool/Client ID、DbSecretArn、队列 URL、Bucket 名、KMS Key ARN、RDS 连接地址（见 `createOutputs`）；
- synth 产物中不包含任何真实凭据：RDS 口令为 `{{resolve:secretsmanager:...}}` 动态引用。

## 5. IAM 最小权限要点

- IoT Rule 角色：仅 `sqs:SendMessage`（+CDK 附带的队列元数据读取）到 Ingress 与 Rule Error 队列；
- Ingestion：读 DB Secret、写 Quarantine、消费 Ingress；Archive：写 Raw Bucket、消费 Archive；Outbox Publisher：读 DB Secret、写 Archive；Summary：读 DB Secret；
- API：读 DB Secret、Media/OTA/Export 对象读写、Raw 只读、证书包 Key 加解密（SEC-01 要求解密权限仅此角色）、`iot:Publish` 收敛到 `bnx/device/*/{cmd,ota,notification}` 三个下行 Topic 模式；
- 设备发放动作（`iot:CreateKeysAndCertificate` 等）不支持资源级收敛，保持动作级白名单 + `Resource: *`（Action 非 `*`，不违反 `*:*` 红线）；
- 模板断言扫描全部 IAM Policy/ManagedPolicy/Role 内联策略，断言不存在 `Action: *` 且 `Resource: *` 的声明。

## 6. 验收命令与实测结果（2026-08-27）

```bash
pnpm --filter @fdp/infra synth     # cdk synth：成功（退出码 0，无需云凭据）
pnpm vitest run infra/test         # 3 个测试文件、27 项断言全部通过
pnpm verify                        # lint/format/typecheck/test/build/boundaries/schemas/migrations/secrets 全链退出 0
```

| 验收基准 | 证据 |
|---|---|
| `cdk synth` 成功 | `infra/cdk.out/fdp-dev-app.template.json` 生成，退出码 0 |
| 无公网 S3/RDS | 断言：5 个 Bucket 全部 `BLOCK_ALL` + TLS 强制拒绝；RDS `PubliclyAccessible: false`、`StorageEncrypted: true` |
| 角色权限没有 `*:*` | 断言：模板全部 IAM 声明扫描，`Action:* ∧ Resource:*` 违规为 0 |
| 三类 API 认证入口分离 | 断言：恰好 3 个 RestApi（onboarding/device/admin）；onboarding/device 方法级 NONE，admin 仅 COGNITO_USER_POOLS + AWS_IAM；提供域名配置时 mTLS 域名 + BasePathMapping 生效且默认入口禁用 |
| 资源名支持环境前缀 | 断言：SQS/S3/IoT Rule/RDS/Lambda/Cognito 名称均含 `fdp-{env}-` |
| 数据库凭据通过 Secrets Manager | 断言：`fdp-{env}-rds-credentials` Secret（KMS 加密），RDS 口令为动态引用 |
| 不引入公网暴露与运维范围资源 | 断言：无 `AWS::CloudWatch::Alarm`、无 WAF、无备份配置；8 个 IoT Rule 与 CT-02 目录一致 |

## 7. 决策与偏差记录

| 项 | 决策 | 理由 |
|---|---|---|
| 数据库引擎 | PostgreSQL 16（`VER_16`） | DB-01 已落地 PostgreSQL（Prisma provider、`btree_gist` 排他约束）；三份方案/运维文档已于 2026-08-27 同步统一为 PostgreSQL |
| `exactOptionalPropertyTypes` | infra 包关闭该单项 | aws-cdk-lib 官方类型与该标志不兼容（`IVpc`/`IBucket` 接口属性为必选但可为 `undefined`）；其余 strict 项保留 |
| Lambda 占位 Handler | `Code.fromInline` 返回 501 | 业务实现属 BE 任务；占位不承诺契约行为，避免绑定未实现的 apps 构建产物 |
| MFA | 池级 OPTIONAL（软件令牌） | Cognito 不支持按组强制 MFA；平台管理员强制策略由 AUTH-01/BE-RBAC-01 收口 |
| NAT | 单 NAT Gateway | 试运营成本基线（方案 §19.2）；Lambda 访问 RDS/AWS 服务所需；扩缩容不在范围 |
| 资源销毁策略 | `RemovalPolicy.DESTROY`、无备份 | 任务功能边界明确排除备份/生产保护；生产保留策略属运维决策 |
| 原始消息 Envelope | Rule SQL 附 `topic()/timestamp()/principal()` | Envelope 正式契约归 BE-IOT-01；此处仅保证原文与最小上下文进入 Ingress |

## 8. 未决风险

- mTLS 自定义域名依赖真实域名、ACM 证书与 CA bundle 上传，synth 阶段无法验证部署态；首次真实部署前需在 dev 完成一次 mTLS 握手演练（属 BE-ONB/QA-03 范围）；
- NAT Gateway 为常驻固定成本（约 $32/月/环境），dev/staging 停机策略属运维范围；
- `autoDeleteObjects: false`：销毁非空 Bucket 需先清空（防止误删原始归档）；
- EventBridge 调度频率（outbox 1min / summary 1h）为初始值，BE-ARC-01/BE-ESG-01 落地时可按实测调整。
