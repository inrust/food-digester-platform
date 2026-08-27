# AWS 云端运维任务清单

## 1. 文档目的

本文根据以下两份文档的全部内容整理，只保留 AWS 云平台建设、部署、配置、安全、监控、备份、容量、成本、故障处置和运行保障相关工作，并将其拆分为可执行的运维步骤：

- 《AWS 云端方案关键问题与解决方案》
- 《AWS 云端业务与管理后台开发实施方案》

涉及 Topic、消息属性、身份字段和数据流的内容，仅在其直接决定 AWS IoT Core、IoT Rules、SQS、S3、IAM、监控或运行策略时保留。

## 2. 筛选口径

### 2.1 纳入运维清单的工作

- AWS 账号、环境、网络、域名、证书、身份和权限基座；
- AWS CDK 部署基线与环境参数管理；
- AWS IoT Core、Thing、证书、IoT Policy、IoT Rules Engine；
- SQS、DLQ、Quarantine Queue、Rule Error Queue；
- Lambda 的部署参数、并发、重试、告警和运行维护；
- RDS PostgreSQL 的部署、加密、备份、恢复、监控和扩容；
- S3 原始归档、OTA、Media、前端、导出和日志桶的运行配置；
- Athena/Glue 查询环境与原始归档审计能力；
- Cognito、API Gateway、CloudFront、KMS、Secrets Manager、CloudWatch、CloudTrail、SNS、EventBridge；
- CI/CD 的 AWS 凭证、部署门禁、回退和生产变更控制；
- 安全加固、成本控制、上线检查、故障 Runbook、容量演练和运行交接；
- 满足触发条件后才执行的 ECS Fargate、Firehose、Parquet、WAF、RDS Multi-AZ、跨区域备份、JITP/JITR/Fleet Provisioning 等扩容任务。

### 2.2 已剥离的开发强相关工作

以下内容不进入运维实施主清单：

- MQTT/REST DTO、JSON Schema、OpenAPI、错误码和业务协议的研发与编码；
- Onboarding、Device Sync、Deactivate、证书轮换 API 的业务代码；
- Customer、Site、Device、License、Entitlement、配置、设备用户等领域模块开发；
- 数据库业务表、Repository、Prisma Migration 和领域状态机实现；
- 消息校验、幂等、乱序处理、聚合、Outbox Publisher、Replay Job 的应用代码；
- Remote Command、ACK、OTA Campaign、Media 上传会话的业务逻辑；
- 管理后台页面、前端交互、报表展示和 CSV 导出功能；
- 单元测试、接口测试、E2E 测试和设备模拟器开发；
- 设备固件、Android Edge、本地离线队列及设备侧 OTA 实现。

上述能力若产生队列、桶、密钥、告警、部署参数或故障处置要求，对应的 AWS 运维配置仍纳入本文。

## 3. 执行标记与阶段

### 3.1 优先级

| 标记 | 含义 |
|---|---|
| P0 | 首台真实设备接入前必须完成 |
| P1 | 10 台设备试运营上线前必须完成 |
| P2 | 试运营期间持续执行或按指标优化 |
| C | 条件触发后实施，不作为 10 台试运营默认配置 |

### 3.2 环境范围

| 环境 | 用途 | 基本约束 |
|---|---|---|
| dev | 日常开发和自动化测试 | 仅模拟数据，不使用生产证书 |
| staging | 真实设备联调和恢复演练 | 使用测试设备和脱敏数据 |
| prod | 最多 10 台设备试运营 | 使用正式证书和正式业务数据 |

## 4. AWS 账号与环境基座

### OPS-BASE-001 建立三套隔离环境（P0）

操作步骤：

1. 确定 dev、staging、prod 使用独立 AWS 账号还是同账号独立资源边界；生产环境优先使用独立账号。
2. 为三套环境定义唯一的资源命名前缀、标签、域名、AWS Region 和负责人。
3. 分别创建或部署数据库、S3 Bucket、Cognito User Pool、IoT Policy、密钥、队列和日志资源。
4. 禁止生产设备证书连接 dev/staging，禁止测试证书访问 prod。
5. 为资源统一添加 `Environment`、`System`、`Owner`、`CostCenter`、`DataClass` 标签。
6. 输出环境资源清单、账号/Region 映射和责任人清单。

完成标准：三套环境资源无名称、证书、密钥、数据库或数据桶混用；能够按标签分别统计资源和成本。

### OPS-BASE-002 建立 AWS CDK 可重复部署基线（P0）

操作步骤：

1. 对目标账号和 Region 执行 CDK Bootstrap，并记录 Bootstrap 版本。
2. 按 network、identity、iot、data、application、monitoring 划分 Stack。
3. 将环境差异放入受控参数，不在代码中写死账号、域名、密钥或生产资源标识。
4. 为各 Stack 定义输出值和依赖关系，避免人工复制 Endpoint 或 ARN。
5. 在空白 dev 环境执行完整部署、销毁非持久资源并重新部署。
6. 对数据库、归档桶、日志桶等持久资源设置合理的删除保护和保留策略。
7. 保存 `cdk synth` 结果并在流水线中检查意外替换、删除和权限扩大。

完成标准：dev 可从空环境重复部署；prod 部署前可看到变更集，持久数据资源不会因普通 Stack 删除而丢失。

### OPS-BASE-003 建立生产访问与变更控制（P0）

操作步骤：

1. 使用 IAM Identity Center 管理生产环境人工访问。
2. 为管理员强制 MFA，禁止共享管理员账号。
3. 创建只读、运维、审计和紧急管理员等角色，默认授予最小权限。
4. 定义生产变更申请、审批、执行、验证和回退记录模板。
5. 限制直接在控制台修改由 CDK 管理的资源；紧急修改后必须回写 IaC。
6. 每季度复核人员、角色、访问密钥和未使用权限。

完成标准：生产操作可归属到具体人员；无日常共享凭据；所有生产变更均可追溯。

### OPS-BASE-004 配置网络与安全组边界（P0）

操作步骤：

1. 为各环境定义独立 VPC、子网和路由边界，或以书面方式确认复用既有 VPC 的隔离措施。
2. 将 RDS 和未来可能使用的 ECS Fargate 工作负载部署在私有子网。
3. RDS Security Group 只允许授权的 Lambda/ECS 工作负载访问数据库端口。
4. 仅为确有出网需求的私网工作负载配置 NAT 或 VPC Endpoint，并比较固定成本。
5. 优先为 S3、SQS、Secrets Manager、CloudWatch Logs 等访问评估 VPC Endpoint，限制 Endpoint Policy。
6. 禁止使用面向全网的入站规则；定期检查闲置 Security Group、ENI、EIP 和 NAT Gateway。
7. 在 staging 验证应用连通、数据库拒绝非授权来源以及必要的 AWS 服务访问。

完成标准：数据库无公网入口；网络流向和出网路径有图和清单；不存在未经说明的 `0.0.0.0/0` 入站规则。

## 5. IAM、KMS 与 Secrets Manager

### OPS-SEC-001 配置服务最小权限角色（P0）

操作步骤：

1. 为每个 Lambda/任务建立独立执行角色，不复用全能角色。
2. 将 IoT、SQS、S3、RDS、KMS、Secrets Manager、SNS 等权限限制到所需动作和具体资源 ARN。
3. 将跨 Customer 管理能力限制给明确的平台管理员角色。
4. 禁止使用通配管理员权限作为长期运行权限。
5. 使用 IAM Access Analyzer 和策略验证功能检查外部访问及过宽权限。
6. 将权限变更纳入 CloudTrail 检索和告警。

完成标准：各工作负载只能访问其运行所需资源；不存在未经说明的 `*:*` 运行权限。

### OPS-SEC-002 管理数据库及应用机密（P0）

操作步骤：

1. 将数据库账号、第三方密钥和敏感配置存入 Secrets Manager。
2. 使用客户托管 KMS Key 加密生产机密，并限制解密主体。
3. 为应用配置通过 ARN 引用机密，禁止写入代码、镜像、流水线变量明文或普通日志。
4. 定义数据库凭据轮换周期；在 staging 验证轮换不中断服务。
5. 为读取、修改、删除机密建立 CloudTrail 审计和异常告警。

完成标准：代码库、部署产物和日志内无明文生产凭据；机密访问和轮换均有记录。

### OPS-SEC-003 配置一次性证书包的 KMS 保护（P0）

操作步骤：

1. 创建专用于待领取设备证书包的 KMS Key，并设置严格 Key Policy。
2. 仅允许发证工作负载加密、对应领取工作负载在授权条件下解密。
3. 配置短期加密存储的 TTL/过期清理机制。
4. 检查日志、Trace、审计字段和错误报告，确保不出现私钥明文。
5. 验证领取成功或新证书 Heartbeat 后可销毁证书包。
6. 演练证书包丢失后的重新签发流程，不提供旧私钥找回。

完成标准：私钥只在 AWS IoT 创建时和授权领取响应中短暂出现，静态存储始终为加密状态且可按规则销毁。

## 6. AWS IoT Core 与设备证书

### OPS-IOT-001 配置 IoT Core 接入基线（P0）

操作步骤：

1. 确认各环境 AWS IoT Data Endpoint 并纳入受控配置。
2. 强制设备使用 MQTT over TLS 和 X.509 双向认证。
3. 按环境配置 Thing 命名规范、Thing Type 和必要属性。
4. 确认 AWS IoT Core 实施 QoS：全部 Topic 使用 QoS 1；ESG Report、Tamper、Command 的协议 QoS 2 适配为 AWS QoS 1。
5. 记录此适配决策，确保 ACK、幂等、序号缺口和对账措施不被取消。
6. 使用测试证书验证连接、发布、订阅、断连和重连。

完成标准：每个环境 Endpoint 明确；合法设备可连接；无证书或错误环境证书无法连接。

### OPS-IOT-002 配置单设备最小权限 IoT Policy（P0）

操作步骤：

1. 将证书、Thing Name 与 `deviceId` 建立一对一绑定。
2. 允许设备只发布自己的上行 Topic：heartbeat、telemetry、report、alarm、event、ack、tamper、media。
3. 允许设备只订阅和接收自己的下行 Topic：cmd、ota、notification。
4. 限制 `iot:Connect` 的 Client ID 与设备身份一致。
5. 明确禁止设备访问其他 `deviceId` 的任何 Topic。
6. 分别执行同设备正向测试和跨设备发布/订阅越权测试。
7. 保存 Policy 版本，变更时进行差异审查并清理旧版本。

完成标准：10 台设备各自使用独立证书；所有跨设备 Topic 越权测试均失败。

### OPS-IOT-003 建立 Thing 与证书生命周期操作（P0）

操作步骤：

1. 为审批后的设备创建 Thing、证书并附加专属 Policy。
2. 确保证书初始状态、Thing 关联和策略附件正确。
3. 首次有效 Heartbeat 后记录证书已投入使用。
4. 证书轮换时保留有限双证书窗口；新证书成功 Heartbeat 后停用旧证书。
5. 配置证书到期前 30、14、7 天通知。
6. 建立证书吊销、设备丢失、管理员误发证和紧急轮换操作步骤。
7. 退役设备在确认或超时策略满足后停用证书并解除运行权限。

完成标准：创建、启用、轮换、停用、吊销和退役流程均在 staging 演练并留有证据。

### OPS-IOT-004 配置连接与安全监控（P1）

操作步骤：

1. 在 CloudWatch 采集 IoT 连接数、断连数、PublishIn、认证失败和 Rule Error。
2. 建立生产设备连续 5 分钟无 Heartbeat 告警。
3. 对认证失败突增、重复断连和跨 Topic 拒绝事件设置阈值。
4. 将告警发送到 SNS 运维通知渠道。
5. 建立按 deviceId、证书 ID 和时间范围定位连接问题的查询方法。

完成标准：人为停用测试证书、使用错误 Topic、停止 Heartbeat 均能触发预期日志或告警。

### OPS-IOT-005 批量制造证书体系升级（C）

触发条件：设备进入批量制造，逐台 Token 审批和云端证书包方式不再满足交付效率。

操作步骤：

1. 与设备制造团队评估工厂预置一机一证、JITP/JITR 或 Fleet Provisioning。
2. 明确 CA、制造环节、设备身份、吊销、审计和泄露处置责任。
3. 在非生产环境完成批量注册和越权测试。
4. 更新证书策略和运维 Runbook，经协议变更审批后切换。

完成标准：新体系不改变既有 Topic 和业务 API，并具备可审计的批量发放与吊销能力。

## 7. IoT Rules Engine

### OPS-RULE-001 建立上行消息路由规则（P0）

操作步骤：

1. 为规定的八类上行 Topic 配置 IoT Rule 匹配条件。
2. 将合法命中消息发送到统一 Ingress SQS。
3. 在送入队列时保留 Topic、接收时间及规则可获得的连接/证书上下文。
4. 为 Rule Action 配置仅允许发送目标队列的 IAM Role。
5. 避免使用设备 Payload 内的 `tenantId/customerId` 作为可信路由依据。
6. 分别用八类消息验证规则命中和队列入站结果。

完成标准：全部上行类型均进入 Ingress SQS，未发生错误的静默丢弃或跨环境路由。

### OPS-RULE-002 配置 Error Action 与错误队列（P0）

操作步骤：

1. 为每条关键 IoT Rule 配置 Error Action，写入独立 Rule Error Queue。
2. 为错误队列启用静态加密、合理保留期和访问控制。
3. 对队列消息数大于 0 建立 CloudWatch Alarm。
4. 验证目标 SQS 拒绝、权限错误或规则执行失败时消息进入错误队列。
5. 编写检查原因、修复配置、重放消息和记录审计的步骤。

完成标准：Rule Action 故障可见、可告警、可定位、可重放，不依赖人工偶然发现。

### OPS-RULE-003 管理规则版本与变更（P1）

操作步骤：

1. 通过 CDK 管理规则 SQL、目标队列和执行角色。
2. 协议增加 Topic 或版本时先在 dev/staging 验证兼容性。
3. 生产变更前确认旧消息仍可路由，必要时保留兼容窗口。
4. 发布后核对 Rule Error、Ingress 数量和各消息类型占比。
5. 为失败变更准备回退至上一个规则版本的操作。

完成标准：规则变更全部通过 IaC 和审批执行，发布后有可量化验证。

## 8. Amazon SQS

### OPS-SQS-001 配置 Ingress SQS（P0）

操作步骤：

1. 创建 Ingress SQS，启用服务端加密。
2. 根据 Lambda 单批最长处理时间配置 Visibility Timeout，避免处理未完成即重复可见。
3. 设置消息保留期，保证故障期间有足够恢复窗口。
4. 配置 Redrive Policy 和独立 Ingress DLQ。
5. 仅允许 IoT Rule 发送、Ingestion 工作负载接收/删除。
6. 配置批量接收、最大批次和部分批次失败响应参数。
7. 用重复投递、Worker 暂停 30 分钟和恢复场景验证队列行为。

完成标准：消息至少一次传递；失败消息达到次数后进入 DLQ；Worker 恢复后队列可自动消化。

### OPS-SQS-002 配置 Archive SQS（P0）

操作步骤：

1. 创建 Archive SQS 和对应 DLQ，启用加密。
2. 仅允许 Outbox Publisher 发送、Archive Worker 接收/删除。
3. 依据归档批处理时长设置 Visibility Timeout、批大小和保留期。
4. 对可见消息数、最老消息年龄和 DLQ 消息数建立告警。
5. 验证 S3 暂时写入失败时消息可重试且不会提前删除。

完成标准：业务入库与归档解耦；归档故障不会静默丢失，恢复后可继续写入。

### OPS-SQS-003 配置 Quarantine Queue（P0）

操作步骤：

1. 创建独立 Quarantine Queue 保存不可重试的 Schema/脏数据消息。
2. 配置只允许消费工作负载发送、授权运维人员只读或受控重放。
3. 设置足以调查问题的消息保留期。
4. 建立消息查看、脱敏导出、判定、修正来源和受控重放流程。
5. 所有人工重放操作记录操作人、原因、范围和结果。

完成标准：坏消息不会阻塞主队列，也不会未经审计直接删除或重放。

### OPS-SQS-004 配置统一队列告警（P1）

操作步骤：

1. 为所有主队列监控 `ApproximateNumberOfMessagesVisible` 和 `ApproximateAgeOfOldestMessage`。
2. Ingress/Archive 最老消息持续超过 60 秒时告警。
3. 所有 DLQ、Rule Error Queue 出现任意消息时告警。
4. 设置告警去重、升级路径和恢复通知。
5. 建立仪表盘展示入站速率、消费速率、堆积和失败量。

完成标准：队列堆积、消费停止和死信产生均在约定时间内通知值班人员。

## 9. AWS Lambda 与 EventBridge

### OPS-LAMBDA-001 配置 Lambda 运行基线（P0）

操作步骤：

1. 为 Ingestion、Archive、Summary、业务/API 等函数设置独立角色。
2. 明确内存、超时、临时存储、环境变量、日志级别和日志保留期。
3. 为 SQS 触发函数启用合理批大小、最大批处理窗口和部分批次失败返回。
4. 控制 Reserved Concurrency，防止突发流量压垮 RDS。
5. 使用版本和 Alias 发布生产函数。
6. 确认函数日志不包含 Token、私钥、完整证书材料或敏感个人信息。

完成标准：函数参数受 IaC 管理；并发受控；敏感信息扫描无明文泄露。

### OPS-LAMBDA-002 配置 Lambda 监控与扩容阈值（P1）

操作步骤：

1. 监控 Error、Throttle、Duration、ConcurrentExecutions 和 SQS 批处理失败。
2. 为连续错误、被限流、Duration 接近超时和并发接近上限设置告警。
3. 关联 SQS 最老消息年龄判断是否需要提高并发或优化批处理。
4. 正常负载下验证 Telemetry 到管理数据可见的 P95 不超过 5 秒。
5. 记录每次内存、并发、批次调整前后的吞吐和成本。

完成标准：Lambda 故障或容量不足可从告警和仪表盘直接识别，并有量化调优依据。

### OPS-EVENT-001 配置定时聚合与巡检任务（P1）

操作步骤：

1. 使用 EventBridge Scheduler 触发小时/日汇总运行任务。
2. 为证书到期检查、归档完整性检查、数据完整率检查等周期任务配置调度。
3. 指定失败重试、最大事件年龄和必要的 DLQ。
4. 监控调度触发成功、函数执行结果和错过运行窗口。
5. 对补跑操作记录时间范围、执行人和结果。

完成标准：周期任务可按计划运行，失败时可告警并可受控补跑。

## 10. Amazon S3

### OPS-S3-001 划分并创建用途独立的 Bucket（P0）

操作步骤：

1. 按原始归档、OTA 包、Media、管理前端、报表导出、生产日志/CloudTrail 划分 Bucket，避免混用权限和保留策略。
2. dev、staging、prod 使用独立 Bucket 和唯一名称。
3. 对全部 Bucket 启用 Block Public Access；CloudFront 访问使用受控源访问机制。
4. 启用默认静态加密；生产敏感桶使用客户托管 KMS Key。
5. 启用 Versioning，并为关键桶设置删除保护或 CDK 保留策略。
6. 配置 Bucket Policy，拒绝非 TLS 请求和未经授权的跨账号访问。
7. 对数据类型设置 `DataClass`、环境和责任人标签。

完成标准：所有 S3 Bucket 均无公网访问；用途、权限、密钥、保留期和负责人明确。

### OPS-S3-002 配置原始数据归档布局（P0）

操作步骤：

1. 使用以下分区前缀：`raw/topic_type={type}/customer_id={customerId}/year={yyyy}/month={mm}/day={dd}/hour={hh}/part-*.json.gz`。
2. 配置 Archive Worker 按批次合并 NDJSON/GZIP，避免一条消息一个对象。
3. 要求归档对象包含原始 Payload、接收时间、Topic、deviceId、customerId、Schema 版本和校验结果。
4. 为每个对象生成或记录记录数、最小/最大设备时间、最小/最大序号、SHA-256、Schema 版本集合、写入时间和 Worker 版本。
5. 使用稳定对象键或 Manifest 支持重复执行去重和审计。
6. 验证 Telemetry、Report、Alarm、Event、Tamper 均能按规则归档；Heartbeat 不做原始归档。

完成标准：可根据 Customer、设备、消息类型和时间定位原始记录；归档对象可校验完整性且无大量逐消息小文件。

### OPS-S3-003 配置保留与生命周期（P1）

操作步骤：

1. 原始 Telemetry/Report/Alarm/Event/Tamper 试运营至少保留 12 个月。
2. 管理审计日志至少保留 2 年；应用/API/访问日志保留 30～90 天。
3. 为报表导出对象配置短有效期自动删除。
4. 为临时上传和失败分段上传配置清理规则。
5. 依据访问频率评估转入低频或归档存储级别，并验证恢复时间满足要求。
6. 在启用规则前检查 Versioning 下非当前版本的生命周期，防止存储持续增长。

完成标准：各数据类型具有书面保留期和自动生命周期规则；不存在无限增长的临时对象或日志。

### OPS-S3-004 配置 OTA 与 Media 访问安全（P1）

操作步骤：

1. OTA 和 Media 使用独立受控 Bucket/Prefix。
2. S3 不公开对象，只通过短期预签名 URL 上传或下载。
3. OTA 下载 URL 建议有效期 15 分钟；Media 和导出链接按最短业务需要设置。
4. 限制上传内容类型、大小、对象键前缀和必要的校验条件。
5. 对 OTA 包上传配置病毒扫描和签名校验流程所需的事件触发及隔离区。
6. 启用对象访问审计，记录导出和媒体下载行为。

完成标准：匿名访问失败；过期 URL 不可使用；上传对象不能越过授权设备或会话的前缀。

### OPS-S3-005 配置 S3 访问与完整性审计（P1）

操作步骤：

1. 为原始归档、OTA、Media、导出和日志桶确定需要记录的 S3 Data Events。
2. 对高价值桶启用 CloudTrail Data Events；如启用 S3 Server Access Logging，目标必须为独立受控日志桶。
3. 监控 Bucket Policy、Public Access Block、Versioning、加密和生命周期规则的变更。
4. 定期抽查归档 Manifest/SHA-256 与实际对象，确认对象未缺失或被替换。
5. 对异常批量读取、删除尝试和公开访问配置安全告警。
6. 评估 Data Events 和访问日志的事件量及成本，避免无范围的重复记录。

完成标准：关键对象访问和配置变更可追踪；归档完整性抽查有记录；日志配置不会形成无控制的重复成本。

### OPS-S3-006 建立不可变归档决策门禁（C）

触发条件：商业合同或合规要求明确原始数据需要 7 年不可删除留存。

操作步骤：

1. 由业务、法务、安全共同确认数据范围、保留期和法律责任。
2. 在新建或满足条件的 Versioning Bucket 上评估 S3 Object Lock Compliance Mode。
3. 在 staging 验证保留、Legal Hold、读取、生命周期和到期行为。
4. 确认启用后无法随意缩短保留期或删除对象的影响。
5. 经正式审批后在 prod 启用并更新灾备、删除和成本 Runbook。

完成标准：只有明确合规依据和审批后启用；保留策略、权限与成本影响均有记录。

## 11. Amazon Athena 与数据湖查询

### OPS-ATHENA-001 建立试运营审计查询环境（P1）

操作步骤：

1. 为 S3 原始归档建立 Glue Data Catalog Database 和按消息类型划分的外部表。
2. 将表分区映射到 `topic_type/customer_id/year/month/day/hour` 前缀。
3. 明确 NDJSON/GZIP 字段、时间格式、Schema 版本和错误记录的兼容方式。
4. 创建独立 Athena Workgroup，指定加密的查询结果 Bucket 和自动清理周期。
5. 设置每次查询扫描量限制或告警，强制使用时间和 Customer 分区条件。
6. 使用 IAM 限制查询者只能访问授权的数据、Catalog 和结果位置。
7. 准备按 Customer、设备、消息类型、时间和序号查询原始记录的标准查询模板。

完成标准：授权审计人员可检索指定范围原始数据；未授权人员无法查询；查询结果受控且会自动清理。

### OPS-ATHENA-002 配置 Athena 成本与可观测性（P1）

操作步骤：

1. 为 Workgroup 启用查询指标并纳入 CloudWatch。
2. 监控扫描字节量、失败查询和查询结果桶增长。
3. 对缺少分区条件的大扫描查询设置限制或运维审查。
4. 定期检查 Glue 分区是否完整，发现归档有对象但 Catalog 无分区时修复。
5. 将常用审计查询的扫描量和响应时间记录为基线。

完成标准：Athena 使用量和成本可见；不存在无限保留的查询结果或无约束全桶扫描。

### OPS-ATHENA-003 升级为 Firehose/Parquet 数据湖（C）

触发条件：原始数据约超过 100GB/月、Athena 扫描成本明显上升或 NDJSON 查询性能无法满足审计需求。

操作步骤：

1. 评估 IoT Rules → Firehose → S3，或保留 Outbox/Archive 链路后由 Firehose 交付。
2. 配置缓冲、动态分区、格式转换、失败备份和错误前缀。
3. 将数据转换为 Parquet，并验证 Schema 演进和压缩效果。
4. 新建 Athena 表或 View，保持旧数据可查询。
5. 对比转换前后的对象数量、扫描量、查询耗时和成本。
6. 完成双写/回填验证后再切换主查询路径。

完成标准：数据完整性不低于原链路，Athena 扫描量和查询成本显著下降，失败记录可追踪。

## 12. Amazon RDS PostgreSQL

### OPS-RDS-001 部署试运营数据库（P0）

操作步骤：

1. prod 采用小规格、单 AZ RDS PostgreSQL 起步；dev/staging 使用独立实例并可按计划停机。
2. 将数据库部署在非公网可访问子网，限制 Security Group 来源到授权工作负载。
3. 启用存储加密、自动小版本维护策略和删除保护。
4. 将凭据存入 Secrets Manager，不在部署配置中明文保存。
5. 设置参数组、时区策略和日志导出，所有业务时间以 UTC 保存。
6. 设定最大连接与 Lambda 并发的容量边界，避免连接风暴。

完成标准：数据库不可从公网连接；凭据受控；实例参数和网络访问均由 IaC 管理。

### OPS-RDS-002 配置备份、快照与恢复（P0）

操作步骤：

1. 启用自动备份，试运营保留 7～14 天。
2. 配置合适备份窗口和维护窗口，避开主要运行时段。
3. 每次生产数据库变更前创建快照并记录对应应用版本。
4. 试运营结束前创建长期保留快照。
5. 在 staging 至少完成一次从自动备份或快照恢复的演练。
6. 记录恢复时间、数据时间点、连接切换、完整性检查和清理步骤。

完成标准：staging 恢复演练可复现，有实际 RTO/RPO 记录，不只确认“备份成功”。

### OPS-RDS-003 配置数据库监控（P1）

操作步骤：

1. 监控 CPU、连接数、可用存储、I/O、慢查询和备份状态。
2. CPU 持续超过 70%、连接超过 80%、存储低于 20% 时告警。
3. 将 CPU 持续超过 60% 作为容量评估触发信号，先检查查询、索引和连接使用。
4. 为备份失败、实例不可用和存储增长异常建立高优先级告警。
5. 每周查看慢查询和连接趋势，记录优化或升配决定。

完成标准：故障、容量和备份异常均能主动告警；有趋势数据支持扩容决策。

### OPS-RDS-004 生产高可用与跨区域保护（C）

触发条件：正式 SLA/审计要求生效、单 AZ 风险不可接受或业务进入规模化生产。

操作步骤：

1. 评估并启用 Multi-AZ，验证切换时间和应用重连行为。
2. 按连接规模评估 RDS Proxy 和只读副本。
3. 定义跨区域快照复制或灾备数据库策略。
4. 执行计划内故障切换和区域恢复演练。
5. 更新 RTO/RPO、成本预算、监控和 Runbook。

完成标准：高可用配置和跨区域恢复经演练验证，满足书面 SLA/RTO/RPO。

## 13. API Gateway、Cognito 与 CloudFront

### OPS-EDGE-001 配置三类独立 API 入口（P0）

操作步骤：

1. 配置 `onboard-api` 入口，使用一次性 Token 认证并设置 Token/IP 限流。
2. 配置 `device-api` 自定义域名和 mTLS Truststore。
3. 配置 `api` 业务/管理入口，使用 Cognito JWT Authorizer。
4. 为三类入口分别设置日志、限流、配额、告警和自定义域名证书。
5. 验证 Onboarding 不被强制 mTLS，Device API 必须 mTLS，管理 API 必须有效 JWT。
6. API Gateway 完成 CA 链校验后，保留应用层证书 Active 状态与设备归属校验要求。

完成标准：三类入口认证边界互不混淆，错误凭据、错误证书和越权请求均被拒绝并可追踪。

### OPS-EDGE-002 配置 Cognito 与管理员 MFA（P0）

操作步骤：

1. 三套环境使用独立 User Pool。
2. Customer 用户与平台管理员使用独立 App Client 或独立 User Pool。
3. 为 PlatformSuperAdmin、PlatformOperator、Auditor 强制 MFA。
4. 配置密码、账号恢复、Token 生命周期和失败登录保护策略。
5. JWT 仅承载身份和角色，不把客户端自报 Customer 范围作为可信授权依据。
6. 监控登录失败和 MFA 变化，并纳入审计。

完成标准：管理员 MFA 强制生效；不同环境和用户群的 Token 不能混用。

### OPS-EDGE-003 配置管理 Web 的 S3 + CloudFront 发布（P1）

操作步骤：

1. 管理 Web 静态资源部署到非公开 S3 Bucket。
2. CloudFront 使用受控源访问连接 S3，终端用户不能绕过 CloudFront 直访 Bucket。
3. 配置 HTTPS 证书、安全响应头、缓存策略和错误页。
4. 静态文件使用内容 Hash 文件名；HTML 使用适合发布切换的缓存时间。
5. 发布后执行缓存失效或版本切换，并验证旧资源兼容性。
6. 监控 CloudFront 4xx/5xx 和源站错误。

完成标准：S3 源站不公开；管理站点全程 HTTPS；发布和回退不会因旧缓存造成资源混用。

### OPS-EDGE-004 配置 API 运行监控和防护（P1）

操作步骤：

1. 监控 API 4xx、5xx、P95 延迟、鉴权失败和限流事件。
2. 分别为三类入口设置符合调用频率的 Throttling。
3. 对异常 Token/IP 请求、持续 5xx 和延迟恶化设置告警。
4. 设置访问日志保留 30～90 天并执行敏感字段脱敏。
5. 定期检查自定义域名证书和 mTLS Truststore 的有效期与更新流程。

完成标准：API 可用性、延迟和鉴权异常可观测；证书更新有提前告警和演练步骤。

### OPS-EDGE-005 启用 WAF 与正式安全加固（C）

触发条件：正式 SLA、互联网攻击面或合规要求生效。

操作步骤：

1. 在 CloudFront/API 入口配置 AWS WAF Web ACL。
2. 先以 Count 模式评估托管规则误报，再切换 Block。
3. 按接口特点配置速率限制、IP 信誉和必要的地理限制。
4. 将 WAF 日志写入受控日志存储并建立高风险命中告警。
5. 配合正式渗透测试修正规则与例外。

完成标准：规则启用无重大业务误伤；攻击与异常流量可监控和追溯。

## 14. CloudWatch、CloudTrail 与 SNS

### OPS-OBS-001 建立统一监控仪表盘（P1）

操作步骤：

1. 创建 IoT、SQS、Lambda、RDS、API、S3 归档和业务完整性仪表盘。
2. 显示连接/断连、PublishIn、Rule Error、队列深度/年龄、Lambda 错误/限流/耗时、RDS CPU/连接/存储、API 4xx/5xx/P95。
3. 增加在线设备数、消息校验失败率、序号缺口、命令成功率、OTA 成功率和每日数据完整率等自定义指标。
4. 为 prod 提供总览仪表盘，为单设备故障提供下钻查询条件。
5. 每月复核无用指标、日志和告警，控制可观测性成本。

完成标准：值班人员可从一个入口判断接入、处理、存储和 API 是否健康，并能定位到具体队列/函数/设备。

### OPS-OBS-002 配置告警与通知矩阵（P1）

操作步骤：

1. 建立 SNS Topic 和运维、安全、业务严重告警的订阅渠道。
2. 配置以下告警：5 分钟无 Heartbeat、Critical Alarm/Tamper、Rule Error Queue 有消息、DLQ 有消息、SQS 最老消息超过 60 秒、Lambda 连续错误/限流、RDS 阈值异常、证书临期、归档超时、每日完整率低于阈值。
3. 为每个告警定义严重级别、负责人、响应时间、升级路径和对应 Runbook。
4. 配置告警恢复通知，避免故障结束后状态不明。
5. 在 staging 逐项注入故障验证通知链路。

完成标准：所有关键告警均有负责人和 Runbook；Critical 告警可在 1 分钟内产生通知。

### OPS-OBS-003 配置日志策略（P0）

操作步骤：

1. 所有应用日志采用结构化 JSON，并包含 traceId、customerId、deviceId、messageId 等必要定位字段。
2. 在日志入口执行敏感信息过滤，禁止 Token、私钥、完整密钥材料和敏感个人信息。
3. 为 dev/staging/prod 设置差异化日志级别和 30～90 天保留期。
4. 对生产关键错误建立 Logs Metric Filter 或等效指标。
5. 限制日志访问权限，跨 Customer 查询只允许审计或平台级角色。
6. 定期检查高基数字段和调试日志，防止费用异常。

完成标准：日志足以按请求/设备/消息追踪，且无敏感明文和无限保留。

### OPS-OBS-004 配置 CloudTrail 审计（P0）

操作步骤：

1. 为生产账号启用覆盖所有 Region 的 CloudTrail。
2. 将 Trail 写入独立加密日志 Bucket，启用日志文件完整性验证和严格 Bucket Policy。
3. 按需要启用关键 S3、Lambda 等数据事件，控制高量事件成本。
4. 对 IAM/Policy、KMS、Secrets Manager、IoT 证书、S3 Policy、CloudTrail 本身的高风险变更设置告警。
5. 定期验证 Trail 正常投递且没有被停用或篡改。

完成标准：AWS 控制面关键操作可归属到身份、时间和来源；Trail 中断会触发告警。

## 15. CI/CD 与发布运维

### OPS-CICD-001 配置无长期密钥的部署身份（P0）

操作步骤：

1. 使用 GitHub Actions OIDC 或等效联合身份连接 AWS。
2. 分环境创建部署角色和信任条件，限制仓库、分支和工作流来源。
3. dev、staging、prod 角色使用不同权限；prod 只允许受保护分支和审批后的工作流。
4. 禁止在流水线保存长期 AWS Access Key。
5. 通过 CloudTrail 记录并定期审查流水线角色使用情况。

完成标准：流水线可部署但无长期访问密钥；非授权仓库/分支不能承担生产角色。

### OPS-CICD-002 配置基础设施发布门禁（P0）

操作步骤：

1. PR 阶段执行 CDK synth、依赖/安全扫描和 IaC 差异检查。
2. 合并后先部署 dev 并运行基础连通性验证。
3. staging 和 prod 前设置人工审批。
4. prod 部署前检查 CDK diff 是否包含资源替换、删除、公开访问或权限扩大。
5. 发布后执行 IoT、队列、API、数据库和归档 Smoke Test。
6. 保存部署版本、审批人、时间、变更内容和验证结果。

完成标准：未审批变更不能进入 prod；高风险基础设施变更在部署前可见。

### OPS-CICD-003 配置发布与回退策略（P1）

操作步骤：

1. Lambda 使用版本与 Alias；关键 API 使用 Canary 或线性流量切换。
2. 管理 Web 使用带 Hash 文件名并保留上一版可回退产物。
3. MQTT Schema/路由变更保留至少一个版本兼容窗口。
4. 应用发布失败时自动或人工回退到上一稳定版本。
5. 数据库变更前确认快照、向后兼容和独立回滚方案；不在生产手工修改 Schema。
6. 演练一次应用回退和一次基础设施配置回退。

完成标准：应用、Web 和基础设施均有明确回退路径；数据库恢复不被误等同于应用回滚。

## 16. ECS Fargate 扩容任务

### OPS-ECS-001 建立 Fargate 迁移判定（C）

触发条件，满足任一项后评估，不按设备数机械迁移：

- Lambda 单任务接近 15 分钟；
- 任务需要长驻连接或持续高 CPU；
- 稳定高并发导致 Lambda 成本出现明显拐点；
- API 冷启动持续影响 SLA，且 Provisioned Concurrency 不经济；
- SQS 堆积经并发和批处理优化后仍不能满足时延目标。

操作步骤：

1. 收集 2～4 周 Lambda Duration、并发、SQS 年龄、CPU 需求和成本数据。
2. 明确只迁移满足条件的 Worker/API，不默认部署五个常驻服务。
3. 比较 Provisioned Concurrency、Lambda 优化与 Fargate 的成本和运行复杂度。
4. 形成迁移范围、容量、可用性、网络和回退决策记录。

完成标准：迁移有量化指标支撑，并明确预期成本、性能收益和回退标准。

### OPS-ECS-002 部署 ECS Fargate 运行基座（C）

操作步骤：

1. 创建 ECS Cluster、Task Definition、Service 和独立 Task Role/Execution Role。
2. 将任务放入私有子网，按需经 ALB/API Gateway 对外提供服务。
3. 镜像存入 ECR，启用镜像扫描和生命周期清理。
4. 配置 CPU/内存、健康检查、最小/最大任务数、滚动部署和 Deployment Circuit Breaker。
5. 对 SQS Worker 使用队列深度/最老消息年龄进行 Service Auto Scaling。
6. 机密通过 Secrets Manager 注入，不写入镜像或普通环境变量明文。
7. 配置日志、指标、任务退出、部署失败和容量不足告警。
8. 在 staging 完成故障替换、扩缩容、滚动升级和回退演练。

完成标准：服务可自动恢复和扩缩容；任务最小权限、私网运行、日志和部署回退均验证通过。

## 17. 成本与容量管理

### OPS-COST-001 配置预算和异常成本告警（P0）

操作步骤：

1. 按账号/环境设置月度 AWS Budget。
2. 配置预算阈值通知和 Cost Anomaly Detection。
3. 使用标签或账号边界区分 dev、staging、prod 成本。
4. 每月按 IoT Core、SQS、Lambda、RDS、S3、CloudWatch、Athena、数据传输等服务复盘。
5. 检查日志、S3 非当前版本、Athena 扫描和空闲 RDS 等主要增长项。
6. 协议冻结后依据真实 Payload、频率、日志量和 RDS 规格，用 AWS Pricing Calculator 更新预算。

完成标准：成本异常能主动通知；每项主要费用可归属到环境和服务。

### OPS-COST-002 控制试运营固定成本（P1）

操作步骤：

1. 试运营优先使用 Lambda、SQS、IoT Core、API Gateway 按量计费。
2. 管理 Web 使用 S3 + CloudFront 静态托管。
3. RDS 使用单 AZ 小规格，dev/staging 按计划停机。
4. 不预先部署多个常驻 Fargate Task。
5. 设置 CloudWatch 日志保留期和 S3 生命周期。
6. 每月检查闲置 EIP、NAT Gateway、快照、旧 Lambda 版本、ECR 镜像和未使用资源。

完成标准：没有缺少业务依据的常驻高固定成本资源；空闲资源有定期清理记录。

### OPS-CAP-001 建立容量触发矩阵（P2）

| 监控信号 | 先执行 | 后续动作 |
|---|---|---|
| SQS 最老消息持续超过 60 秒 | 检查错误、批量参数、RDS 瓶颈 | 提高 Lambda 并发或优化批处理；必要时评估 Fargate |
| RDS CPU 持续超过 60% | 优化查询、索引和连接 | 评估升配、Proxy、Multi-AZ/副本 |
| 原始数据约超过 100GB/月 | 检查小文件、压缩和 Athena 扫描 | 引入 Firehose + Parquet |
| Lambda 接近 15 分钟/需长连接 | 拆分任务并核算成本 | 迁移对应 Worker 到 ECS Fargate |
| API 高并发且冷启动影响 SLA | 评估内存和 Provisioned Concurrency | 迁移对应 API 到 Fargate |
| 正式 SLA/审计生效 | 评估风险与 RTO/RPO | Multi-AZ、WAF、Object Lock、跨区域备份 |

完成标准：每月检查指标并记录“保持现状、调优或扩容”的决定，不以设备数量单独作为扩容依据。

## 18. 上线前演练与验收

### OPS-TEST-001 执行接入和消息链路演练（P1）

操作步骤：

1. 在 staging 验证 10 台独立证书和单设备 Topic 权限。
2. 连续运行 24 小时：Telemetry 每 10 秒、Heartbeat 每 60 秒。
3. 模拟 10 台设备同时恢复并补报 24 小时历史数据。
4. 注入瞬时 30 倍稳态速率、5% 重复、2% 乱序和 Schema 错误。
5. 暂停 Worker 30 分钟后恢复，观察 SQS 堆积和消化。
6. 验证 IoT → SQS → Lambda → RDS/S3 全链路指标、日志、DLQ 和归档结果。
7. 对未解释的数据缺口不得直接关闭，必须形成追踪记录。

完成标准：合法消息 100% 进入业务链路或可追踪重试队列；无未解释丢失；重复业务记录为 0。

### OPS-TEST-002 执行故障和恢复演练（P1）

操作步骤：

1. 注入 IoT Rule Action 失败，验证 Rule Error Queue 和告警。
2. 注入 Lambda 失败和限流，验证重试、DLQ、告警和恢复。
3. 注入 S3 写入失败，验证 Archive SQS 保留和恢复归档。
4. 从 RDS 自动备份/快照恢复到 staging，并核对数据完整性。
5. 对指定设备、时间和序号范围执行归档重放。
6. 演练证书吊销/紧急轮换、OTA 批次暂停和管理员账号失陷处置。
7. 记录实际发现时间、响应时间、恢复时间、数据影响和改进项。

完成标准：备份恢复、DLQ、归档重放和关键安全故障均至少成功演练一次。

### OPS-TEST-003 执行试运营上线检查（P1）

上线前逐项确认：

- [ ] dev、staging、prod 完全隔离；
- [ ] CDK 可从空环境重复部署；
- [ ] RDS 自动备份已启用并通过恢复演练；
- [ ] SQS DLQ、Quarantine、Rule Error Queue 和告警可用；
- [ ] S3 已阻断公网访问并启用 Versioning；
- [ ] Secrets Manager、日志和流水线无明文凭据/私钥；
- [ ] AWS Budget 和异常成本告警已配置；
- [ ] 10 台设备各自使用独立证书且不能访问其他设备 Topic；
- [ ] Onboarding 发证、证书轮换和吊销已演练；
- [ ] Critical 告警通知链路已验证；
- [ ] CloudTrail、生产日志和审计存储正常；
- [ ] 30 倍突发、重复、乱序、断网补报、Worker 暂停场景通过；
- [ ] DLQ 和归档重放演练通过；
- [ ] Runbook、联系人、响应时限和升级机制已移交；
- [ ] 已形成上线批准记录、已知问题清单和回退计划。

## 19. 运维 Runbook 清单

每份 Runbook 至少包含：触发条件、告警来源、影响判断、首要止损动作、诊断步骤、恢复步骤、数据核对、升级联系人、回退条件和事后复盘要求。

### RB-01 设备无法连接

1. 按 deviceId 检查最近 Heartbeat 和 IoT 连接/认证失败指标。
2. 核对证书 Active 状态、有效期、Thing/Policy 附加关系和环境 Endpoint。
3. 检查 Client ID、Topic 权限和设备时间偏差。
4. 必要时执行证书轮换；疑似泄露则先停用旧证书。
5. 恢复后确认设备立即 Sync、补报数据和序号缺口状态。

### RB-02 Onboarding 发证失败

1. 检查 IoT CreateKeysAndCertificate、Thing 创建、Policy 附加和 KMS 加密错误。
2. 确认日志未记录私钥明文。
3. 判断证书包是否仍在领取有效期。
4. 已销毁或失效时重新签发，不尝试恢复旧私钥。
5. 清理未使用证书并记录审批、处置和结果。

### RB-03 SQS 堆积

1. 查看队列深度、最老消息年龄、入站/删除速率和 Lambda 错误/限流。
2. 判断瓶颈在函数、RDS、S3、权限还是下游依赖。
3. 在数据库承受范围内调整批次或并发。
4. 持续跟踪最老消息年龄直至恢复。
5. 核对是否产生 DLQ、序号缺口或归档缺失。

### RB-04 DLQ、Quarantine 与 Rule Error 处理

1. 保存消息样本并按错误类型、设备和时间分类。
2. 修复权限、规则、Schema 来源或应用配置。
3. 在 staging 验证修复后，按受控批次重放。
4. 观察重复处理、队列年龄和下游写入结果。
5. 记录操作人、原因、消息范围和最终状态；禁止无记录删除。

### RB-05 RDS 故障和时间点恢复

1. 判断实例、连接、存储、查询还是凭据问题。
2. 保护当前证据并确定目标恢复时间点。
3. 恢复到新实例，完成完整性和应用兼容检查。
4. 通过受控配置切换连接，持续观察错误和队列积压。
5. 稳定后处理旧实例并更新恢复记录。

### RB-06 归档缺失与重放

1. 对比 Outbox、Archive SQS、S3 对象/Manifest 和 Athena 分区。
2. 确定缺失的 deviceId、topicType、时间和 seq 范围。
3. 修复 S3、KMS、权限、Worker 或 Catalog 问题。
4. 使用稳定键执行重放，避免生成重复归档事实。
5. 校验对象 SHA-256、记录数、时间和序号边界。

### RB-07 证书吊销和紧急轮换

1. 确认受影响证书、Thing、设备、Customer 和最后连接时间。
2. 泄露或失陷时立即停用证书并阻断其连接。
3. 通过授权流程签发新证书，使用有限双证书窗口或现场恢复方案。
4. 新证书有效 Heartbeat 后清理旧附件和证书包。
5. 检查异常 Topic、跨设备访问和数据完整性。

### RB-08 Remote Command 异常

1. 检查 API、IoT Publish、目标 Topic、设备在线状态和 ACK 关联。
2. 已过期命令不得在设备重连后重新发布。
3. 对高风险命令优先采取安全停止和人工现场确认。
4. 核对命令请求、审批、发布、ACK、超时和失败审计链。
5. 仅在幂等和状态允许时重试。

### RB-09 OTA 批次暂停与回滚协调

1. 发现失败率或安全异常时暂停 Campaign，不扩大批次。
2. 停止生成新的下载 URL/IoT Job，确认已下发目标范围。
3. 检查 OTA 包 Hash、签名、型号、版本和 S3 访问日志。
4. 与设备团队协调设备侧回滚并持续跟踪状态。
5. 经单台验证和审批后决定恢复、取消或更换包。

### RB-10 管理员账号失陷

1. 立即禁用用户、撤销会话并检查 MFA 变化。
2. 检查 CloudTrail、Cognito、API 和业务审计中的异常操作。
3. 轮换可能接触的机密并回退未授权权限/配置变更。
4. 检查跨 Customer 查询、数据导出、证书、命令和 OTA 操作。
5. 保存证据，按安全事件流程通报和复盘。

## 20. 日常、周期与事件驱动运维

### 每日

- 检查 prod 告警、DLQ、Rule Error、Quarantine 和未恢复事件；
- 检查设备离线、证书异常、归档延迟和每日数据完整率；
- 检查 RDS 备份状态、SQS 最老消息年龄和 Lambda 错误；
- 对人工重放、紧急权限和生产变更记录进行复核。

### 每周

- 查看 RDS CPU/连接/存储和慢查询趋势；
- 查看 S3 存储增长、非当前版本和生命周期执行情况；
- 查看 Athena 扫描量、失败查询和 Glue 分区完整性；
- 查看 IoT 认证失败、异常断连和跨 Topic 拒绝；
- 抽查 CloudTrail 投递、日志脱敏和告警通知有效性。

### 每月

- 复盘 AWS 成本、Budget 和异常费用；
- 依据容量触发矩阵评估 Lambda、RDS、S3/Athena 和 Fargate；
- 复核 IAM 权限、闲置资源、旧镜像、旧函数版本和快照；
- 抽测一个 Runbook 或恢复场景；
- 更新联系人、值班升级路径和已知问题清单。

### 每季度

- 复核生产人员访问、MFA、角色和未使用权限；
- 演练证书吊销/轮换、数据库恢复或归档重放中的至少一项；
- 复核日志、审计和数据保留策略；
- 根据业务合同重新评估 Multi-AZ、WAF、Object Lock 和跨区域备份。

## 21. 运维交付物

- [ ] AWS 账号、Region、环境和资源清单；
- [ ] AWS CDK 基础设施代码与部署参数说明；
- [ ] IAM 角色、IoT Policy、KMS Key 和 Secrets 清单；
- [ ] IoT Rules、SQS/DLQ/Quarantine、Lambda 事件源配置清单；
- [ ] S3 Bucket、前缀、加密、Versioning、生命周期和保留策略；
- [ ] Athena/Glue Catalog、Workgroup、权限和标准查询模板；
- [ ] RDS 网络、参数、备份、监控和恢复记录；
- [ ] API Gateway、Cognito、CloudFront 域名、证书和认证配置；
- [ ] CloudWatch 仪表盘、告警矩阵、SNS 订阅和日志保留策略；
- [ ] CloudTrail 配置和关键安全事件告警；
- [ ] CI/CD 部署身份、环境审批、发布和回退说明；
- [ ] AWS Budget、成本基线与容量触发记录；
- [ ] 十份故障 Runbook；
- [ ] 性能、故障、备份恢复和重放演练报告；
- [ ] 试运营上线检查、批准记录和已知问题清单。

## 22. 实施顺序总览

1. **基座先行**：完成环境隔离、CDK Bootstrap、IAM、KMS、Secrets、生产访问控制。
2. **设备接入**：完成 IoT Endpoint、Thing/证书、单设备 Policy、Rules 和 Error Action。
3. **可靠消息链路**：完成 Ingress/Archive SQS、DLQ、Quarantine、Lambda 事件源和队列告警。
4. **数据层**：完成 RDS 安全与备份、S3 分桶与归档布局、Athena 审计查询环境。
5. **访问面**：完成三类 API 入口、Cognito MFA、CloudFront 静态站点和证书管理。
6. **可观测性**：完成 CloudWatch、CloudTrail、SNS、日志保留、告警矩阵和成本告警。
7. **发布与演练**：完成 OIDC 流水线、发布门禁、故障注入、恢复、重放和上线检查。
8. **试运营值守**：执行日/周/月巡检，并按指标决定是否启用 Fargate、Firehose/Parquet、Multi-AZ、WAF、Object Lock 或跨区域备份。

---

本清单按“10 台设备轻量试运营”设计。未达到明确触发条件时，不应提前部署多个常驻 ECS Fargate 服务、高规格或 Multi-AZ RDS、Firehose/Parquet、S3 Object Lock Compliance、WAF 或跨区域灾备；但相关决策、监控指标和切换步骤必须提前保留。
