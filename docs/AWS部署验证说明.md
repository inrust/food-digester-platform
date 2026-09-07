## 真实 AWS 部署前提

AWS 服务通常不需要单独“购买授权”，开通 AWS 账号、绑定付款方式后按量计费即可；本项目不需要 AWS Marketplace 产品或预付实例。

当前 CDK Stack 会创建：

- AWS IoT Core：Thing、证书、Policy、8 条 IoT Rule
- API Gateway：Onboarding、Device、Admin 三个 REST API
- Lambda：API、Ingestion、Provisioning、Deadline、证书恢复等
- RDS for PostgreSQL 16：`db.t4g.micro`、20 GB gp3、Single-AZ
- VPC：两个 AZ、一个 NAT Gateway、私有及隔离子网
- SQS：Ingress、Archive、Quarantine、Rule Error 及 DLQ
- S3：Raw、OTA、Media、Export、mTLS Truststore
- KMS：两个客户管理密钥
- Secrets Manager：RDS 凭据
- Cognito User Pool
- EventBridge 周期任务
- CloudWatch Logs、IAM、CloudFormation

这些服务均是按量模式。IoT Core、Lambda、SQS、API Gateway 通常在少量设备验证阶段成本较低；主要固定成本会来自持续运行的 RDS 和 NAT Gateway。AWS 的 NAT Gateway 按小时和流量计费；官方美国区域示例仅小时费约为 `$0.045 × 730 ≈ $32.85/月`，实际新加坡等区域价格应重新计算。[NAT Gateway 定价](https://aws.amazon.com/vpc/pricing/)

此外：

- 两个客户管理 KMS Key 当前基础存储费约 `$2/月`，不含调用费。[AWS KMS 定价](https://aws.amazon.com/kms/pricing/)
- Secrets Manager 通常按 Secret 数量和 API 调用计费，官方基准为 `$0.40/Secret/月`。[Secrets Manager 定价](https://aws.amazon.com/secrets-manager/pricing/)
- ACM 为 API Gateway 等集成服务签发的非导出公有证书通常免费。[ACM 定价](https://aws.amazon.com/certificate-manager/pricing/)
- 域名和 DNS 如果尚未具备，需要 Route 53 或其他 DNS 提供商；AWS Private CA 不是本次验证必需品。
- 建议先用 [AWS Pricing Calculator](https://aws.amazon.com/aws-cost-management/aws-pricing-calculator/) 按实际区域生成预算，并创建 50%、80%、100% 告警。[AWS Budgets 设置](https://docs.aws.amazon.com/cost-management/latest/userguide/create-cost-budget.html)

## 推荐部署方式

### 1. 使用隔离测试账号

不要直接部署到生产账号。建议：

- 独立 AWS 测试账号
- 单一区域，例如 `ap-southeast-1`
- 使用 IAM Identity Center 或短期角色凭据
- 设置预算告警
- 不接入生产域名、真实客户数据或生产设备证书

本地工具链：

```bash
node --version       # 需要 24.12.x
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm install --frozen-lockfile
aws sts get-caller-identity --profile fdp-test
```

### 2. 部署前先关闭仓库 Gate

目前 `pnpm verify` 仍被既有 P2 问题阻断：

- 7 个 `admin-web` 文件格式不合规
- 2 个重复 OpenAPI `operationId`

P1 的定向测试、类型、构建、迁移和 CDK 检查均通过，但生产部署前仍应先让完整 Gate 退出 0：

```bash
pnpm verify
```

### 3. CDK Bootstrap

每个账号与区域组合只需 Bootstrap 一次。CDK 会创建部署资产所需的 S3、ECR 和 IAM 角色。[AWS CDK Bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)

```bash
export AWS_PROFILE=fdp-test
export AWS_REGION=ap-southeast-1

pnpm --filter @fdp/infra exec cdk bootstrap \
  aws://<AWS_ACCOUNT_ID>/ap-southeast-1
```

### 4. 首次部署测试环境

当前 Stack 强制生产环境配置 Device API mTLS。P1 Onboarding API 本身使用一次性 Token，不依赖 Device API mTLS，因此首次实网验证可使用明确受限的 `test` 环境：

```bash
pnpm --filter @fdp/infra build

pnpm --filter @fdp/infra exec cdk diff AppDependencies \
  -c envName=test \
  -c allowInsecureDeviceEndpointForLocal=true

pnpm --filter @fdp/infra exec cdk deploy AppDependencies \
  -c envName=test \
  -c allowInsecureDeviceEndpointForLocal=true \
  --require-approval broadening
```

部署前必须逐项检查 `cdk diff`，特别是：

- IAM 权限扩大
- KMS Key Policy
- RDS/S3 删除策略
- API Gateway 是否公开
- Lambda 是否使用真实 S3 Asset，而非内联占位函数

CDK 部署需要有效凭据、已 Bootstrap 的环境，并通过 CloudFormation 创建资源和上传 Lambda Assets。[AWS CDK Deploy](https://docs.aws.amazon.com/cdk/v2/guide/deploy.html)

### 5. 执行数据库 Migration

这是当前仓库部署流程中的明显缺口：CDK 会创建私有 RDS，但不会自动执行 Prisma Migration。

RDS 位于隔离子网，不能从开发电脑或 CloudShell 直接连接。AWS 官方也说明私有 RDS 只能由 VPC 内资源访问。[RDS PostgreSQL 连接说明](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ConnectToPostgreSQLInstance.html)

推荐新增一次性 VPC CodeBuild Migration Job：

1. CodeBuild 放入 Stack 的私有 egress 子网。
2. 为它创建独立 Security Group。
3. DB Security Group 只允许该 Migration SG 访问 5432。
4. 从 Secrets Manager 读取连接参数，不输出数据库密码或完整 URL。
5. 执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @fdp/database exec prisma migrate deploy
pnpm --filter @fdp/database db:seed
```

6. 验证 `_prisma_migrations` 和 `onboarding_provisioning_jobs`。
7. Migration Job 完成后撤销临时访问权限。

CodeBuild 支持加入 VPC并访问私有 RDS。[CodeBuild VPC 支持](https://docs.aws.amazon.com/codebuild/latest/userguide/vpc-support.html)

在这个 Migration Runner 补齐前，当前 Stack 不能算“一键可运行部署”。

### 6. 准备验收数据

仓库当前也没有公开的 Onboarding Token 签发 API，需要使用受控的一次性运维任务：

1. 在数据库创建一台 `PendingOnboarding` 库存设备。
2. 调用 `issueOnboardingToken` 生成一次性 Token。
3. Token 仅在终端显示一次，不写 CloudWatch、审计或普通工单。
4. 创建 Cognito `PlatformSuperAdmin` 测试用户。
5. 使用支持 Cognito SRP 的测试客户端取得 JWT。

## P1 真实闭环验证

### 正常链路

1. 调用 Onboarding Request：

```http
POST <OnboardingApiUrl>/api/v1/device/onboarding/request
Authorization: Bearer <ONBOARDING_TOKEN>
Content-Type: application/json
```

验证响应必须严格为：

```json
{
  "requestId": "...",
  "status": "PENDING"
}
```

不得出现 `data`、`meta`、`serialNumber` 或 `createdAt`。

2. 使用 Cognito 管理员 JWT 审批：

```http
POST <AdminApiUrl>/api/v1/admin/onboarding/requests/<REQUEST_ID>/approve
Authorization: Bearer <COGNITO_JWT>
If-Match: 1
```

验证：

- Request 进入 `APPROVED`
- Device 进入 `OnboardingApproved`
- 创建一个 Provisioning Job
- 管理响应不含私钥或证书材料

3. 等待一分钟级 Provisioning Worker：

- Job：`PENDING → PROCESSING → COMPLETED`
- `attempts=1`
- `lastError=null`
- AWS IoT 中 Thing、ACTIVE Certificate、Policy、Thing Principal 全部存在
- Certificate 带 request/operation 标签
- CloudWatch 无 KMS、Secrets Manager、RDS 或 IoT AccessDenied

4. 不带任何 Query 调用 Status：

```http
GET <OnboardingApiUrl>/api/v1/device/onboarding/status
Authorization: Bearer <ONBOARDING_TOKEN>
```

验证 APPROVED 响应的顶层及嵌套结构，并将私钥只保存在权限为 `0600` 的临时文件中，禁止写入验收日志。

5. 验证领取后状态：

- Token 已核销
- `package_ciphertext` 已销毁
- 第二次使用 Token 被拒绝
- CloudWatch、审计和数据库均不含私钥明文

6. 使用取得的 IoT Certificate/Private Key 连接 AWS IoT Core，发布合法 Heartbeat 到：

```text
bnx/device/<deviceId>/heartbeat
```

AWS IoT 使用 X.509 证书认证，并由附加 Policy 决定允许的 MQTT 操作。[AWS IoT X.509 证书](https://docs.aws.amazon.com/iot/latest/developerguide/x509-client-certs.html)

验证消息经过：

```text
IoT Rule → Ingress SQS → Ingestion Lambda → RDS
```

最终 Device 应进入 `Onboarded`。

BE-IOT-01 与 QA-03 的发布证据必须按 [BE-IOT AWS 数据链路证据采集说明](audit/evidence/BE-IOT-AWS数据链路证据采集说明.md)覆盖八类 Topic、未知 Topic、Rule Error Action、partial failure、Quarantine、receipt、RDS/outbox、Archive SQS/S3 原文一致性，并执行：

```bash
pnpm check:aws-iot-evidence
```

缺少结构化目标环境回执时该命令必须失败；不得用本地 `pnpm verify` 或 CDK synth 替代。

### 权限负向验证

仓库已有真实 AWS 授权矩阵脚本，会创建两台临时 Thing、测试自身/跨设备权限并清理资源：

```bash
FDP_AWS_IOT_INTEGRATION=1 \
AWS_PROFILE=fdp-test \
AWS_REGION=ap-southeast-1 \
pnpm test:aws-iot-authz
```

应生成：

```text
docs/audit/evidence/auth-04-aws-iot-authorization.json
```

要求全部允许/拒绝探针和清理步骤通过。AWS IoT 会合并证书、Thing 与 Thing Group 上的策略，因此应验证目标环境的最终授权结果，不能只检查单份 Policy JSON。[AWS IoT 授权](https://docs.aws.amazon.com/iot/latest/developerguide/iot-authorization.html)

### 重试与补偿验证

仅在隔离测试账号执行故障注入：

1. 临时对 Provisioning Worker Role 增加显式 Deny：
   - `kms:GenerateDataKey`
   - `iot:UpdateCertificate`
2. 创建并批准新申请。
3. 验证：
   - 发证后的封包操作失败
   - 补偿撤证失败时 Job 保留 `issuedCertificateId`
   - Job 进入 `RETRY`
   - `attempts`、`lastError`、`nextAttemptAt` 已记录
4. 移除临时 Deny。
5. 等待下一轮 Worker。
6. 验证旧证书被撤销、新证书签发且 Job 进入 `COMPLETED`。
7. 达到最大重试次数时，验证：
   - Job 进入 `FAILED`
   - 产生 `ONBOARDING_PROVISIONING_FAILED` Outbox 事件
   - 产生 `onboarding.provisioning.exhausted` 审计记录

不要在生产账号修改 IAM 来做这项测试。

### 超时收敛验证

无需等待真实 24 小时：

1. 创建并批准一条申请，等待证书包生成。
2. 通过受控数据库运维任务把 `onboardingDeadlineAt` 调整到当前时间之前。
3. 调用 Status。
4. 验证：
   - 外部返回 `REJECTED / ONBOARDING_TIMEOUT`
   - Request 落地 `TIMED_OUT`
   - Device 回退 `PendingOnboarding`
   - 本地证书进入 `REVOKED`
   - 证书包被销毁
   - AWS IoT Certificate 进入 `INACTIVE`
   - `revocationCompletedAt` 与审计日志存在
5. 临时阻断撤证再重复一次，确认失败状态会被 Deadline Lambda 下一轮重试。

## 正式生产前仍需整改

当前基础设施适合隔离测试，不适合直接生产：

- RDS 为 Single-AZ、无备份、无删除保护
- RDS、KMS、Cognito、S3 使用 `DESTROY` 策略
- S3 非空时 Stack 删除可能失败
- Archive、Outbox Publisher、Summary 仍有占位实现
- 管理后台 CloudFront/S3 部署未在当前 Stack 中落地
- 没有正式 Migration/Seed Runner
- 生产 mTLS 首次部署存在 truststore Bucket 与对象创建顺序问题
- CDK 只创建 API Gateway mTLS Domain/Mapping，不创建 DNS Alias

生产前应拆分 Foundation/Data/API Stack，先创建 Truststore Bucket并上传 CA，再配置 Regional ACM Certificate、mTLS Domain 和 DNS。API Gateway mTLS 要求 Regional 自定义域名、同区域 ACM 证书以及 S3 Truststore；默认 execute-api 入口应关闭。[API Gateway mTLS 官方要求](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-mutual-tls.html)

因此建议验收顺序为：

```text
隔离测试账号部署
→ Migration/Seed
→ P1 正常闭环
→ AWS IoT 权限负测
→ 重试/补偿故障注入
→ 超时收敛
→ 清理并保存脱敏证据
→ 修复生产基础设施缺口
→ staging
→ production
```
