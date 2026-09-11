# AWS 运维账号权限与服务预算申请说明

日期：2026-09-11  
用途：提交项目方，用于创建运维身份、分配 AWS 权限及安排测试期预算。  
状态：服务与权限申请方案；尚未代表已开通服务、已部署或已通过真实 AWS 验收。

## 一、申请结论

项目方保管 AWS 根用户、账号所有权、付款方式及财务管理权限，为运维人员创建实名、启用 MFA 的登录身份。优先采用 IAM Identity Center 分配角色和临时凭据，不共享根用户，不默认授予长期 AdministratorAccess。

管理后台前端采用 **AWS Amplify Hosting**：授权连接指定 GitHub 仓库，配置 `apps/admin-web` 的 Monorepo 构建规则及发布分支；该分支更新后自动编译和部署。前端不再单独搭建 S3 + CloudFront，也不需要为此增加 CodePipeline、CodeBuild 或 GitHub Actions。

API、设备消息处理和数据库继续采用 API Gateway + Lambda + IoT Core + SQS + RDS PostgreSQL + S3。后端首次通过 CDK 和临时运维部署角色部署；前端导入 GitHub 不会自动完成后端部署。

本次仅申请一套供 10 台设备联调的测试环境，月度预算控制目标为 **300 美元（税前）**：服务规划额 **260 美元**，预算内余量 **40 美元**。在下述流量、日志和构建用量范围内，该目标可作为部署预算；实际费用按用量计收，预算通知不会自动停费。

## 二、问题 1、2：需要开通的服务、用途及预计月费

### 2.1 估算口径

- 暂按 AWS 商业区域新加坡 `ap-southeast-1` 的部署场景编制预算；区域尚未由项目方最终确定。若采用中国区域或其他区域，需重新核对服务可用性、GitHub 连通性和价格。
- 下表是**单套环境的保守月度规划估算**，不是逐 SKU 的正式 AWS 报价。已查阅官方计费方式；区域单价和实际账单应在部署前使用 AWS Pricing Calculator 复核。
- 10 台设备持续在线，按 30 天、常驻资源约 730 小时/月估算；假设每台每分钟合计约 2 条上行消息，单条不超过 5 KB，约 86.4 万条/月，另留命令、重试、补报余量。此频率只是估算输入，不变更设备协议。
- 管理后台不超过 20 名月活用户，采用静态构建、TOTP MFA；前端每月不超过约 1,000 标准构建分钟、20 GB 下行及少量构建产物；API 每月不超过约 100 万次请求。
- S3 当前存量按约 50 GB、业务公网下载按约 50 GB/月估算；无持续视频流。旧版本、长期累计归档、频繁 OTA 下载会增加费用。
- Lambda 暂按约 200 万次调用、平均 512 MB / 200 ms，加上归档和汇总余量；部署后以真实批处理、执行时长、补报量修正。
- 日志按约 5 GB/月、1 个仪表盘、约 10 项自定义指标及 20 项标准告警估算；Athena 按不超过约 0.5 TB/月扫描估算。普通应用日志保留 7 天，审计记录单独设保留策略。
- 不依赖免费额度、赠金、预付折扣或长期合约；金额为美元、税前，不包含人工、汇率差、付费支持计划及 GitHub 付费套餐。

### 2.2 单套测试环境服务清单

“规划额”是对应上述测试用量的分项预算，实际用量较小时可低于该金额。DNS、邮件费用也已纳入 300 美元以内；API 自定义域名使用项目方已有域名的子域名。

| 服务 | 用途及初始配置 | 月度规划额（USD） | 开通安排 / 官方计费依据 |
|---|---|---:|---|
| AWS Amplify Hosting | 前端 GitHub 自动构建、静态托管、HTTPS 和分发；指定仓库及分支 | 15 | 必需；[计费](https://aws.amazon.com/amplify/pricing/) |
| AWS IoT Core / Rules Engine | 10 个 Thing、一机一证、MQTT 收发、上行规则路由 | 5 | 必需；[计费](https://aws.amazon.com/iot-core/pricing/) |
| Amazon SQS | Ingress、Archive、DLQ、Quarantine、Rule Error 等队列 | 3 | 必需；[计费](https://aws.amazon.com/sqs/pricing/) |
| AWS Lambda | API、接入处理、归档、汇总、证书、命令及超时任务；按需执行 | 12 | 必需；[计费](https://aws.amazon.com/lambda/pricing/) |
| Amazon API Gateway | Onboarding、设备 mTLS、业务/管理三类入口；按实际 API 类型计费 | 5 | 必需；[计费](https://aws.amazon.com/api-gateway/pricing/) |
| Amazon RDS for PostgreSQL | 1 个 `db.t4g.small` 单 AZ 实例，约 50 GiB 通用 SSD；含存储、少量额外备份及 CPU 突增预留 | 65 | 必需；型号以区域支持为准；[计费](https://aws.amazon.com/rds/postgresql/pricing/) |
| Amazon S3 | Raw、OTA、Media、Export、日志、Athena 结果、Truststore 及部署产物；含请求和业务下载预留 | 15 | 必需；不重复计入 Amplify 前端分发；[计费](https://aws.amazon.com/s3/pricing/) |
| Amazon Cognito | 管理后台身份、JWT、管理员 MFA；测试环境独立 User Pool | 3 | 必需；暂不选高级威胁防护和短信 MFA；[计费](https://aws.amazon.com/cognito/pricing/) |
| Amazon EventBridge / Scheduler | 汇总、业务超时及维护调度 | 2 | 必需；[计费](https://aws.amazon.com/eventbridge/pricing/) |
| AWS KMS | 证书包专用加密密钥、其他敏感资源加密；约 3–5 把客户托管密钥及请求余量 | 6 | 必需；[计费](https://aws.amazon.com/kms/pricing/) |
| AWS Secrets Manager | 数据库凭据、外部服务密钥；约 5 项机密及请求余量 | 5 | 必需；[计费](https://aws.amazon.com/secrets-manager/pricing/) |
| Amazon CloudWatch | 日志、指标、仪表盘、告警、少量日志检索 | 25 | 必需；[计费](https://aws.amazon.com/cloudwatch/pricing/) |
| AWS CloudTrail | 控制面审计、限定范围的数据事件；日志对象存储已计入 S3 | 5 | 必需；不默认开 CloudTrail Lake；[计费](https://aws.amazon.com/cloudtrail/pricing/) |
| Amazon SNS | 运维邮件告警和通知 Topic | 2 | 必需；暂不启用短信；[计费](https://aws.amazon.com/sns/pricing/) |
| Athena + Glue Data Catalog | 原始归档审计查询、表及分区元数据；不部署 Glue ETL | 5 | 10 台试运营验收前完成；[Athena](https://aws.amazon.com/athena/pricing/)、[Glue](https://aws.amazon.com/glue/pricing/) |
| VPC / NAT Gateway / Endpoint / 公网 IPv4 | 私有 RDS 与 Lambda 连通；暂按 1 个 NAT、相关 IPv4、少量处理流量预留，并使用 S3 Gateway Endpoint | 80 | 必需网络，收费组件按实部署；不要同时无依据铺设大量 Interface Endpoint；[计费](https://aws.amazon.com/vpc/pricing/) |
| Amazon Route 53 | DNS 托管及查询 | 5 | 按需配置；使用已有域名，已有外部 DNS 可继续使用；[计费](https://aws.amazon.com/route53/pricing/) |
| Amazon SES | 业务邮件或自定义 Cognito 邮件 | 2 | 可选；需要真实邮件时开通，完成发件身份验证及所需 sandbox 限制处理；[计费](https://aws.amazon.com/ses/pricing/) |
| AWS Certificate Manager | API 的不可导出公有 HTTPS 证书；前端证书由 Amplify 管理 | 0 | 集成服务用证书无证书费；不采购 Private CA；[计费](https://aws.amazon.com/certificate-manager/pricing/) |
| IAM / IAM Identity Center / STS | 人员登录、临时会话、服务角色和授权 | 0 | 不单独预留身份服务费；相关运行资源按上表计费 |
| CloudFormation / CDK 引导依赖 | 部署及更新基础设施，保留部署产物；可能包含空闲 ECR 引导仓库、SSM 引导参数 | 0 | 无单独计算采购；产物存储计入 S3，本次使用函数代码包部署 |
| AWS Budgets / Cost Anomaly Detection / Cost Explorer | 预算告警、异常费用和成本查看 | 0 | 基础预算通知和人工成本查看；不默认启用收费预算操作或高频成本 API；[Budgets 计费](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/) |
| **服务规划额合计** | **包括 DNS、邮件额度** | **260** | **单套测试环境** |
| **预算内余量** | **吸收测试用量的正常波动** | **40** | **已包含在总预算内** |
| **建议月预算** | **一套 10 台设备联调环境** | **300** | **未税；不是固定套餐或费用硬上限** |

NAT 与 Interface Endpoint 的最终选择须覆盖实际 IoT 控制面/数据面、SQS、KMS、Secrets Manager、Scheduler 及外部 Webhook 等访问需求，不能仅因省钱而遗漏连通路径。VPC 本身不收取本表所列固定网络费，主要收费来自 NAT、Interface Endpoint、IPv4 和传输；S3 Gateway Endpoint 无额外费用。

### 2.3 300 美元预算的控制措施

1. 保留单 AZ RDS 小实例和 1 个 NAT 的预算，数据库保持私有访问；不依靠停机或免费额度才能达到目标。RDS 自动备份保留 7 天。
2. Amplify 使用标准构建实例，仅指定测试发布分支自动构建；控制在每月约 1,000 构建分钟内，继续保留 GitHub 更新自动发布功能。
3. S3 配置测试数据生命周期，控制在约 50 GB 存量及 50 GB/月业务下载；OTA/Media 通过 S3 预签名 URL 直传直下，避免经 Lambda/NAT 转发文件。
4. 应用日志控制在约 5 GB/月、保留 7 天；保留关键告警和审计，不逐条打印完整设备 Payload。Athena 查询强制带时间/设备分区条件，设置扫描限制。
5. Lambda 设置合理批处理和并发，API 设置限流，防止异常重试放大费用；不改变既定设备上报协议来凑预算。
6. 设置 **150、240、270、300 美元**费用通知及预测超支告警，同时通知项目方和运维人员。达到 240 美元或预测超支时检查主要费用项，优先减少非必要重复构建、全量日志检索及重复文件下载。预算告警不是账单硬上限。

以上缩减主要来自更贴近 10 台设备测试期的日志、存储、下载及按量服务额度；RDS 与网络规划额保持不变。部署首周按实际用量复核月度预测，后续每周检查，目标维持在 300 美元/月以内。

## 三、问题 3：是否需要创建 IAM Role / Service Role

**需要。人员角色、部署角色和 AWS 服务运行角色分别创建。**建议由项目方管理员完成身份基座、权限边界和 CDK bootstrap；运维人员通过受限角色完成项目部署。

### 3.1 运维人员身份及权限范围

建议优先为项目建立独立 AWS 工作负载账号；如项目方使用 Organizations，管理/付款账号不承载本项目日常业务。由项目方在工作负载账号分配 IAM Identity Center 权限集，启用 MFA。若没有 Identity Center，可使用实名 IAM 控制台身份配合受限角色和临时凭据，不共享账号。

| 权限集 / 角色（建议名称） | 申请内容 | 使用周期 |
|---|---|---|
| `FDP-ReadOnlyOps` | 查看本项目资源配置、指标、日志、部署状态和脱敏诊断；不默认读取数据库内容、S3 业务对象和 Secret 明文 | 长期 |
| `FDP-AppDeploy` | 对指定 Amplify App 查看构建、重试/发布；后端经指定 CDK Deploy Role 更新项目 Stack；按发布职责分配 | 需要承担持续发布时保留 |
| `FDP-InfraSetup` | 初始创建/配置项目服务、网络、域名映射、日志告警；对项目 IAM 角色进行受边界约束的创建、更新和 PassRole | 首次部署及批准的基础设施变更期间临时开放 |
| `FDP-CostReadOnly` | 查看本项目成本、预测、预算及异常费用，不访问付款信息 | 长期或由项目方提供月报替代 |

作用域限定为项目账号、环境、资源 ARN 和命名前缀，例如 `fdp-*`，结合 `Project=food-digester-platform`、`Environment` 标签。部分服务列举、创建和全局操作不支持资源级限定，应单独列出必要动作，并用账号、区域、可用条件及权限边界补充；不能仅依赖标签。

允许服务对应的创建/配置/查询/更新动作，但不等于直接授予所有服务 FullAccess。VPC 网络操作使用的 IAM 命名空间是 `ec2`，只需要 VPC、Subnet、Route、Security Group、ENI、Endpoint、NAT、EIP 等网络动作，不需要 `ec2:RunInstances`。部署还需要 CloudFormation、CDK 引导 S3/ECR/SSM 资源访问和限定的 STS AssumeRole 权限。

区域以最终选定业务区域为主；IAM、Route 53 等全局服务，以及 Amplify 域名证书所需区域依赖应设置明确例外，不能用单一区域 Deny 误伤。AWS 管理员应依据最终资源清单生成实际 IAM 策略，本文件不将未验证的通配权限作为可直接套用策略。

### 3.2 应用与部署服务角色

| 角色类别 | 用途及最小授权原则 |
|---|---|
| Lambda Execution Roles | 各 API/Worker 分别配置执行角色；仅访问所需队列、桶前缀、密钥、Secret、IoT API、调度器和日志；VPC 函数配置必要网络接口权限 |
| IoT Rules Role | 允许指定 IoT 规则向指定 Ingress / Error 队列发送消息，按需要授权加密密钥 |
| EventBridge Scheduler Role | 仅允许指定计划调用指定 Lambda 或目标服务，含必要 DLQ 权限 |
| CDK Deploy / Asset Publishing / Lookup Roles | 支持部署、产物上传和环境查询，仅信任授权人员或后续指定发布身份 |
| CloudFormation Execution Role | 代表部署流程创建和更新本项目资源；限定可创建服务、项目角色及权限边界；不直接沿用无限制 AdministratorAccess |
| Amplify 相关角色 | 本次为静态前端 Hosting，不为其授予后台部署或数据库权限；纯静态托管不预设 SSR Compute Role。若实际构建模式或 AWS 功能要求服务角色，仅增加该功能所需权限 |
| Service-linked Roles | RDS 等 AWS 服务确有需要时创建；首次创建由项目方管理员完成，或临时允许限定 `iam:AWSServiceName` 的 CreateServiceLinkedRole |

`iam:PassRole` 仅允许传递明确列出的项目角色，并限制 `iam:PassedToService`；不允许任意角色。角色创建/修改须强制项目方定义的 Permissions Boundary，并防止运维身份移除边界、修改自己的授权或改变信任关系提权。限制同样适用于 CloudFormation 执行角色，否则仍可借部署间接提权。

创建角色的临时权限可以收回，但被 Lambda、Scheduler、IoT 和后续部署使用的角色必须保留。[Amplify 角色说明](https://docs.aws.amazon.com/amplify/latest/userguide/add-IAM-roles.html)、[CDK 引导角色说明](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

## 四、问题 4：是否需要命令行或 API Access Key

**需要 AWS CLI / SDK / CDK 的程序化访问；不需要预先创建长期 IAM Access Key。**

| 使用方 | 认证方案 |
|---|---|
| 运维人员命令行、SDK、CDK | 通过 IAM Identity Center 登录获取临时凭据，或通过项目方批准的 STS AssumeRole 临时会话；有会话期限并启用 MFA |
| Lambda / IoT Rules / Scheduler | 使用各自执行角色，AWS 自动提供临时凭据 |
| Amplify 自动拉取 GitHub | 由仓库所有者安装并授权 Amplify GitHub App，仅访问指定仓库；不把 AWS Access Key 写入仓库 |
| 后续如增加后端 GitHub Actions | 使用 OIDC 联合身份和限定仓库、分支/Environment 的角色；此次不因前端自动发布而要求开通 |
| 10 台设备 | IoT X.509 设备证书；不是 IAM Access Key |

AWS 临时凭据也可能包含 Access Key ID、Secret Access Key 和 Session Token，但属于短期会话，不是长期固定密钥。项目方无需向运维人员发送根用户密钥或长期密钥。[CLI 临时认证说明](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html)

GitHub 仓库授权是独立于 AWS IAM 的操作：项目方需提供对指定仓库安装/批准 GitHub App 的配合。运维人员无需取得整个 GitHub 组织的长期管理员权限。前端环境变量仅放 API 地址等公开构建配置，不放数据库密码或 AWS 凭据；此类内容会进入浏览器代码。

前端首次需配置构建目录、依赖安装、输出目录、API 地址和 SPA 路由回退。连接 GitHub 不等于已经验证本仓库可以发布；需完成首次成功构建和页面验收。后续测试发布分支更新自动部署；该分支设置保护和合并审核。[Amplify GitHub 连接](https://docs.aws.amazon.com/amplify/latest/userguide/setting-up-GitHub-access.html)

## 五、问题 5：是否需要访问账单或付款信息

**需要项目费用的只读查看，不需要付款信息或财务管理权限。**

| 内容 | 申请范围 |
|---|---|
| Cost Explorer 成本、服务用量、预测 | 只读，用于排查 RDS、网络、日志和传输成本 |
| Budgets / Cost Anomaly Detection | 查看预算和异常；初始配置可由项目方完成，或临时允许运维人员配置项目通知 |
| 月度费用明细 | 项目范围的服务/环境费用即可；不强制授予发票或付款页面访问 |
| 信用卡、银行账户、付款方式、实际付款 | **不需要** |
| 税务资料、发票抬头、账号所有权、关停账号 | **不需要** |
| Organizations 付款账号、其他项目账单、购买长期承诺 | **不需要** |

不直接授予覆盖所有财务页面的宽泛账单策略，应按 Cost Management 的必要查看动作配置。项目方如需开启 IAM/角色账单控制台访问，由账号管理员处理。成本数据不一定能通过普通资源标签实现严格隔离；共享账号中如无法限制到本项目，优先使用项目专属工作负载账号，或由项目方提供成本报表，不要求查看全组织财务。[AWS 账单访问管理](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/control-access-billing.html)

## 六、问题 6：部署完成后可收回或降级的权限

| 权限 | 部署完成后的处理 | 保留方式 |
|---|---|---|
| 根用户、付款和组织管理 | 从始至终不授予运维人员 | 项目方保管 |
| IAM 创建用户/角色/策略、修改信任和边界 | 收回日常访问；需要变更时临时授权 | 保留受限 AssumeRole / PassRole，仅限实际部署职责 |
| CDK bootstrap、引导角色和信任配置修改 | 收回 | CDK 引导资源和运行角色保留，不删除 |
| VPC、NAT、Endpoint、安全组及路由创建/变更 | 降为只读 | 网络变更临时提权 |
| RDS 创建、删除、升配、恢复、取消删除保护 | 降为查看状态、监控和批准的启停 | 恢复演练、升配或迁移临时提权 |
| S3 Bucket Policy、KMS Key Policy、密钥删除 | 收回常态修改权限 | 应用角色继续保有所需读写/加解密能力 |
| Secret 明文读取、数据库管理员凭据、业务对象读取 | 默认不作为长期运维权限保留 | 故障处理或迁移按具体 Secret、对象和时间临时授予 |
| IoT 发证、吊销、Policy 修改 | 人员日常降为查看 | 由已授权后台业务流程和执行角色处理；紧急人工操作临时提权 |
| Amplify 建站、仓库重连、分支配置、域名/环境变量变更、删站 | 首次配置后收回或限指定 App | 保留构建查看、必要的重试/回退；GitHub 自动构建授权继续保留 |
| API / Lambda / CDK 发布 | 按长期维护职责保留受限部署角色，或改为批准后临时启用 | 不保留任意函数/Stack 的全账号部署权限 |
| CloudTrail 停止/删除、审计日志删除 | 不作为日常运维权限保留 | 项目方控制；保留必要审计查看 |
| CloudWatch / SNS 告警配置 | 保留查看、排障和限定项目告警的调整权限 | 不授予随意删除审计证据权限 |
| 预算修改 | 初次配置后收回或由项目方管理 | 保留成本只读、预算查看和告警接收 |
| GitHub App 安装和组织管理 | 一次性授权完成后收回人员组织管理权限 | App 对指定仓库的必要连接权限保留 |

收权时检查“人员权限”和“服务角色权限”是否分离：收回人的初始化权限，不应删除应用运行角色、GitHub App 连接、CDK 发布依赖或 DNS 验证记录。收权后验证一次 GitHub 提交自动发布、API 冒烟、设备消息链路及告警，确认继续正常运行。

## 七、项目方创建账号时的执行清单

1. 创建或指定项目工作负载账号，项目方保留根用户、恢复方式和付款权限。
2. 为运维人员创建实名 MFA 身份，分配长期只读运维、成本只读，以及有期限的首次部署权限。
3. 由管理员建立项目 IAM 权限边界、初始服务角色和 CDK bootstrap，避免给人员或 CloudFormation 执行角色无限管理员权限。
4. 按本文件第二节启用服务使用权限，按单套测试环境 300 美元/月安排预算。
5. 配合授权 Amplify GitHub App 到指定仓库，明确发布分支；提供域名 DNS 配合，无需提供长期 AWS 密钥。
6. 首次部署验收后执行第六节降权清单，交接资源清单、角色 ARN、告警联系人、预算及部署回退说明。

## 八、项目依据与范围说明

- [管理后台开发任务清单](管理后台开发任务清单.md)：IAC-01、身份权限、IoT/归档/后台业务和前端开发任务。
- [AWS 云端运维任务清单](AWS云端运维任务清单.md)：网络、服务部署、备份、监控、预算和权限管理。
- [AWS 云端业务与管理后台开发实施方案](AWS云端业务与管理后台开发实施方案.md)：第 5 节架构、第 17 节发布、第 19.2 节成本原则。
- 本次申请范围仅为单套测试环境。
- 本轮确认的调整：前端由原手动 S3 + CloudFront 发布改为 Amplify Hosting GitHub 自动发布；不据此要求新增前端 CodePipeline/CodeBuild，也不重构后端为 Amplify Backend。
- 本文件为申请和预算规划，不是已部署清单、正式报价或已通过 AWS 验收的证明。费用依据于 2026-09-11 查阅的官方页面；区域、实际用量及所需功能确定后复核。
