# AWS 测试环境部署配置与执行手册

更新日期：2026-09-17。批准人：Anray。当前授权已包含专用测试 CA/truststore 准备、自定义 Bootstrap、源码提交与只读 synth/diff；仍不包含应用 Stack 部署、数据库初始化或 DNS 修改。

## 1. 账号与域名

版本化配置：`infra/environments/esgiot-test.json`。资源环境名保持 `test`，Stack 为 `fdp-test-app`，账号 `065986019555`，区域 `ap-southeast-1`；使用生产命名不表示已具备生产可用性。

| 入口 | 域名 | 当前接线 |
|---|---|---|
| Device REST | `device-api.bio-nexa.com` | Regional mTLS，固定 CA 对象版本，关闭 execute-api |
| Admin/Customer REST | `api.bio-nexa.com` | Regional TLS，Cognito/IAM，根路径映射保留 `/api/v1/` |
| Onboarding REST | `onboard-api.bio-nexa.com` | Regional TLS，应用层一次性 Token，根路径映射 |
| Admin Web | `admin.bio-nexa.com` | 精确 CORS Origin；Amplify App/域名绑定尚未执行 |
| Device MQTT | `iot.bio-nexa.com` | 此轮不新增 IoT DATA Domain Configuration |
| Customer Web | `platform.bio-nexa.com` | 仅保留，不部署、不加入 CORS |

域名来源：[AWS域名与证书架构评估](AWS域名与证书架构评估.md)。隔离账号仍须使用独立测试 CA、设备证书及测试数据。变更生产命名的 DNS 可能影响现有调用方，必须先核实 DNS 所有权、现有记录及切换影响，并单独批准。

角色：基础设施预检/部署用 `esgiot-infra`；应用工件/手动构建用 `esgiot-dev`；环境检查用 `esgiot-readonly`。已登录身份不等于具备所有部署权限，不在聊天提供密码、密钥或 Session Token。

## 2. 必填输入与失败关闭

本地环境变量仅存非秘密的资源定位信息，未填写时 `node scripts/esgiot-cdk.mjs synth` 会失败，不使用虚构 ARN：

| 输入 | 要求 |
|---|---|
| `FDP_DEVICE_API_CERTIFICATE_ARN` | 同账号、同区域 ACM，ISSUED，覆盖 Device 域名 |
| `FDP_PUBLIC_API_CERTIFICATE_ARN` | 同账号、同区域 ACM，ISSUED，SAN 同时覆盖 `api` 与 `onboard-api` |
| `FDP_TRUSTSTORE_BUCKET_NAME` | 提前创建、版本化、私有且可被 API Gateway 读取的受控 S3 Bucket |
| `FDP_TRUSTSTORE_VERSION` | 已上传测试 CA bundle 的非空 VersionId，非 delete marker |

Key 默认 `truststore/ca-bundle.pem`。先准备 Bucket/对象再创建 mTLS 域名，避免同一 Stack 新建空 Bucket 的首次部署顺序错误。现有 Stack 内 truststore Bucket 保留用于兼容本地测试，但本账号部署使用外部预置 Bucket。CA 内容/链、ACM 覆盖范围与对象存在性需要真实只读预检；本地 ARN 校验不证明其有效。

`scripts/esgiot-cdk.mjs` 只允许 synth/diff，核对 STS 账号并显式绑定区域，覆盖 `cdk.json` 的 local/insecure 默认值；禁止 deploy/destroy/bootstrap。diff 已固定使用 `--no-change-set`，避免仅预检也创建 CloudFormation Change Set。真实应用部署必须另行批准。

## 3. 自定义 Bootstrap

Bootstrap 模板位于 `infra/bootstrap/fdp-test-bootstrap-template.yaml`，Stack 名为 `fdp-test-bootstrap`，qualifier 为 `fdptest01`。模板创建固定资产 Bucket/ECR、SSM 版本参数以及 deploy、CloudFormation execution、file publishing、image publishing、lookup 五个角色；五个角色都必须挂载 `FDP-DeploymentBoundary`，应用 Stack 创建的服务角色必须挂载 `FDP-ServiceBoundary`。

部署前必须先创建：

- `FDP-ServiceBoundary`
- `FDP-DeploymentBoundary`
- `FDP-CloudFormationExecutionPolicy`

`FDP-InfraSetup` 当前权限只允许管理小写 `policy/fdp-*`，并把角色边界固定为既有 `FDP-PermissionsBoundary`，无法创建上述三份策略或使用新部署边界。IAM Identity Center 管理员须把 `infra/iam/FDP-InfraSetup-bootstrap-additions.json` 合并到该 Permission Set；该补充仅允许三个精确策略 ARN、五个精确角色 ARN及向 CloudFormation 传递 execution role。应用后须重新登录 SSO，再执行 Bootstrap。

## 4. CORS 行为与验收

仅 `/api/v1/admin/*`、`/api/v1/customer/*` 开放 `https://admin.bio-nexa.com`。允许 GET/POST/PUT/PATCH/DELETE/OPTIONS，以及 Authorization、Content-Type、If-Match、Idempotency-Key、X-Request-Id；不使用 `*`、不开放 cookie credentials。

OPTIONS 是显式未认证的 Lambda 代理方法，在冷启动 Secret/DB/认证之前返回；未知 Origin、方法、请求头及 Internal 路径预检返回 403。普通请求仍执行原认证，成功及应用错误返回精确 Origin 和 Vary。网关默认 4xx/5xx 使用固定批准 Origin，不反射请求头。Lambda 代理集成须由后端返回 CORS 头。[AWS CORS 文档](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-cors.html)

上线前从实际 Amplify 页面验收预检、401/403/409/500 和写操作；当前仅有本地测试及模板证明，不是目标浏览器回执。

## 5. Migration Runner 操作边界

CodeBuild 项目只按需运行，无自动触发、无自动重试、并发上限 1、超时 20 分钟；使用现有私有 egress 子网/NAT，独立无入站 SG，RDS 5432 单独授权。IAM 只读取当前 DB Secret/对应 KMS 和迁移源码 Bucket，不授予应用管理权限。CodeBuild 私有 VPC 访问公网依赖 NAT。[AWS CodeBuild VPC 文档](https://docs.aws.amazon.com/codebuild/latest/userguide/vpc-support.html)

使用 Ubuntu standard:7.0、Node 24、pnpm 10.20.0 和 frozen lockfile。Node 24 在此镜像受支持。[AWS Runtime 文档](https://docs.aws.amazon.com/codebuild/latest/userguide/available-runtimes.html)

批准真实部署及数据库初始化后，按以下顺序执行（本轮未执行）：

1. 提交并批准准确 40 字符 SHA。运行 `node scripts/package-migration-source.mjs <SHA> /private/tmp/fdp-migration-<SHA>.zip`；只打包 Git 已提交树，工作区修改/本地凭据不进入工件。临时解包目录包含源码而非凭据，按本地清理策略移除。
2. 对 ZIP 计算 SHA-256并保存；通过 `esgiot-dev` 上传到输出 `MigrationSourceBucketName` 的 `migration/source.zip`，记录 S3 VersionId。上传权限应仅限该前缀；CodeBuild 的读取授权并不自动授予人员上传权限。
3. 使用 `aws codebuild start-build --profile esgiot-dev --region ap-southeast-1 --project-name <MigrationRunnerProjectName> --source-version <S3-VersionId> --environment-variables-override name=FDP_EXPECTED_SOURCE_COMMIT,value=<SHA>,type=PLAINTEXT`。批准的对象版本和 SHA 必须一起记录；禁止不指定版本使用 latest。
4. 构建先核对 `migration-source-commit.txt`，不匹配批准 SHA 时在安装/读取 Secret 前失败。生产授权者还须核验工件 SHA-256 与批准打包记录；源码声明本身不是防篡改签名。
5. Runner 在内存中读取 Secrets Manager，使用 RDS CA bundle 校验 TLS，执行 `prisma migrate deploy`；日志不转发 Prisma/驱动错误，防止连接 URL 泄漏。随后事务执行幂等 `seed.sql`，仅五角色字典与 ESG 基线版本，不创建客户/设备/账号样本。迁移非跨文件总事务；失败不自动回滚/resolve/retry，先只读诊断并重新批准。
6. 保存 BuildId、CodeBuild 整体状态、S3 VersionId、ZIP SHA-256、源码 SHA、脱敏输出和 `_prisma_migrations` 验证结果；确认无失败/未完成迁移并检查关键表。JSON 成功输出仅代表迁移/字典步骤，不代表整套 AWS 环境验收。
7. 测试完成后按批准清理计划移除 Runner/SG 授权和受 RETAIN 保护的迁移源码 Bucket；不自动删除数据。

## 6. 前端配置及下一审批包

Amplify 使用 `apps/admin-web/dist/web`、SPA fallback，并从输出填入 Cognito region/pool/client。当前源码要求 `VITE_ADMIN_API_BASE_URL=https://api.bio-nexa.com`（不额外追加 `/api/v1`）；另填 `VITE_COGNITO_REGION`、`VITE_COGNITO_USER_POOL_ID`、`VITE_COGNITO_CLIENT_ID`。不要填写密钥/JWT。

两个 ACM 证书和版本化 CA 对象已于 2026-09-17 实时核验，真实参数 synth/diff 已通过。SES/Webhook 业务通知及其配置要求已从当前部署范围移除，后续有明确需求时重新立项接入。RDS 当前为测试级 Single-AZ、无备份/删除保护，不可凭域名直接作为生产环境。

测试环境设备证书采用单一项目 CA：Secrets Manager Secret `fdp-test-device-ca` 保存 `caCertificatePem` 与 `caPrivateKeyPem`，仅签发/轮换 Lambda 可读取。Onboarding 在内存生成私钥和项目 CA 叶证书，以 `RegisterCertificateWithoutCA` 注册到 AWS IoT，并将同一证书包交付设备；设备使用它连接 MQTT 和 `device-api.bio-nexa.com`。CA 私钥不得进入仓库、CloudFormation 参数、Lambda 环境变量或日志。

Migration 使用 Prisma schema engine 的 `sslmode=require`、`sslaccept=strict` 和 CA 路径；Seed 使用 pg 的 `rejectUnauthorized=true`。不能将 libpq 的 `verify-full` 参数直接当作 Prisma 校验策略。[Prisma TLS 参数](https://docs.prisma.io/docs/orm/v6/overview/databases/postgresql)。实际证书错误/主机名不匹配负测仍须在目标执行。

当前公共 truststore 已上传；Bootstrap 因 `iam:CreatePolicy` 权限边界阻断而未部署。应用部署、Migration、DNS 切换与目标验收均为 **NOT RUN / NO RECEIPT**。
