# AWS 云端方案关键问题与解决方案

## 1. 文档目的

本文基于《Device-Cloud Communication Design》和《厨余设备 ESG 物联网平台 AWS 架构设计与技术方案》，结合以下项目边界，对原方案中的关键问题、影响和解决方案进行收口：

- 早期试运营最多接入 10 台设备；
- 本阶段只开发 AWS 云端相关业务系统和管理后台；
- 不包含设备固件、Android Edge、本地数据库和本地离线队列的开发；
- 云端仍需定义清晰的设备接入协议，供设备团队实现和联调；
- 试运营阶段优先控制复杂度和固定成本，同时避免形成后期难以迁移的技术债务。

### 1.1 参考文档优先级

本项目以《Device-Cloud Communication Design》作为业务模型、设备生命周期、MQTT Topic、Payload、QoS、REST API、同步流程和数据保留策略的第一事实源。《厨余设备 ESG 物联网平台 AWS 架构设计与技术方案》只用于选择 AWS 服务和实现方式。

发生冲突时按以下顺序处理：

1. 默认采用《Device-Cloud Communication Design》的定义；
2. AWS 方案不得静默改变设备协议或业务状态机；
3. 只有 AWS 服务存在明确硬限制时，才允许提出技术适配；
4. 技术适配必须记录原定义、适配值、原因、影响和设备端配合事项，经双方确认后进入协议新版本；
5. 《Device-Cloud Communication Design》内部存在歧义时，以更具体的 API、Payload 示例和业务流程图优先于概念性描述，并将歧义列入协议冻结清单。

## 2. 调整后的总体判断

10 台设备的试运营规模不会形成显著的 AWS 吞吐或数据库容量压力。现阶段应把主要精力放在协议正确性、设备身份、业务状态机、数据完整性、管理操作审计和真实设备联调，而不是提前为数千台设备配置大量常驻容器和高规格数据库。

建议采用“轻量试运营架构 + 明确扩容边界”的方式：

1. 试运营阶段以 AWS IoT Core、SQS、Lambda、RDS PostgreSQL、S3、Cognito、API Gateway 和 CloudFront 为主；
2. 原始数据进入 S3，RDS 只保存业务数据、最新状态、告警和聚合结果；
3. 所有基础设施使用 AWS CDK 管理，后期可以在不改变业务协议的前提下将高负载 Worker 迁移到 ECS Fargate；
4. 不降低证书、权限、幂等、审计和 OTA 安全标准，这些能力后期返工成本最高。

## 3. 试运营负载基线

设备通信设计中，Heartbeat 每 60 秒一次，Telemetry 每 10～60 秒一次。10 台设备的基础消息量如下：

| 场景 | Heartbeat/天 | Telemetry/天 | 合计/天 | 合计/月 |
|---|---:|---:|---:|---:|
| Telemetry 每 60 秒 | 14,400 | 14,400 | 28,800 | 约 86.4 万 |
| Telemetry 每 10 秒 | 14,400 | 86,400 | 100,800 | 约 302.4 万 |

上述规模对 IoT Core、SQS 和 Lambda 都很低，RDS 也能处理经过批量写入后的业务数据。但如果把每一条原始 Telemetry 长期写入 RDS，仍会造成无必要的数据膨胀，因此试运营阶段也应坚持“原始数据归档到 S3、RDS 保存热数据和聚合结果”的原则。

## 4. 关键问题与解决方案

### 4.1 MQTT Topic 规范不一致

**问题**

设备通信文档使用 `bnx/device/{deviceId}/{messageType}`，AWS 方案使用 `esg/{tenantId}/{deviceId}/telemetry`。两个规范在命名、租户字段位置和消息类型覆盖范围上不一致。

**影响**

- IoT Policy 和 Rules Engine 无法在协议冻结前稳定配置；
- 由设备直接提交 `tenantId` 存在租户伪造风险；
- Heartbeat、Report、Alarm、Event、ACK、Tamper、Media 等消息没有完整路由定义。

**解决方案**

统一采用以下 Topic：

```text
设备上行：bnx/device/{deviceId}/heartbeat
          bnx/device/{deviceId}/telemetry
          bnx/device/{deviceId}/report
          bnx/device/{deviceId}/alarm
          bnx/device/{deviceId}/event
          bnx/device/{deviceId}/ack
          bnx/device/{deviceId}/tamper
          bnx/device/{deviceId}/media

云端下行：bnx/device/{deviceId}/cmd
          bnx/device/{deviceId}/ota
          bnx/device/{deviceId}/notification
```

`tenantId` 不放在设备可自由填写的 Topic 中。设备通信设计中的权威业务实体名称是 `Customer`，AWS 方案中的 tenant 仅作为多租户隔离实现概念。云端根据设备证书、Thing 和设备台账查询设备所属 Customer，并在内部记录中补充 `customerId`；如果数据库沿用 `tenant_id`，必须明确它就是 Customer ID，不能形成第二套业务实体。IoT Policy 必须把设备证书限制到自身 `deviceId` 对应的 Topic。

### 4.2 QoS 2 与 AWS IoT Core 不兼容

**问题**

原设备协议将 ESG Report、Tamper、Command 等消息定义为 QoS 2，但 AWS IoT Core 只支持 QoS 0 和 QoS 1。

**解决方案**

- Heartbeat、Telemetry、Alarm、Event、ACK、Media、OTA 和 Notification 继续使用通信设计规定的 QoS 1；
- ESG Report、Tamper 和 Command 因 AWS IoT Core 不支持 QoS 2，实施值由 QoS 2 适配为 QoS 1；
- 所有消息携带全局唯一 `meta.id` 和 `meta.ts`；设备上行运行数据按通信设计携带单调递增 `meta.seq`；
- 上行消息按 `deviceId + messageType + seq` 建立幂等键，下行 Command 以 `meta.id/commandId` 幂等；
- 命令必须使用 `commandId` 与 ACK 关联，并具有明确的超时时间和最终状态；
- 业务上接受“至少一次投递”，通过幂等和对账获得等效的一次处理结果。

这是对主参考文档的必要技术适配，不是用 AWS 方案覆盖通信设计。协议 V1 应同时保留 `specifiedQos=2` 和 `awsEffectiveQos=1` 的决策记录，设备端和云端共同确认后实施。

### 4.3 Onboarding、JITR 和证书发放流程冲突

**问题**

设备文档要求先使用 Onboarding Token 提交申请，经管理员审批后取得设备证书；AWS 方案直接采用 JITR。JITR 要求设备首次连接前已经持有受信 CA 签发的证书，不能直接实现“审批后才首次发证”的流程。

**按主参考文档实施的试运营方案**

采用“Onboarding Token + 管理员审批 + 云端证书包”，不使用 JITR：

1. 每台试运营设备预置一次性 Onboarding Token；
2. 设备按通信设计提交 `serialNumber`、`model`、`hardwareVersion`、`manufacturer` 和 `manufactureDate`；
3. API 返回 `requestId` 和 `PENDING`，设备每 30 秒查询一次状态；
4. 管理员审核并批准或拒绝申请；
5. 批准后云端创建 Device ID、AWS IoT Thing、证书和最小权限 Policy；
6. `onboarding/status` 返回通信设计规定的 `deviceId`、`certificatePem`、`privateKey`、MQTT Endpoint 和初始配置；
7. 设备安装证书并连接 AWS IoT Core；
8. 云端收到首个 Heartbeat 后，把外部生命周期从 `OnboardingApproved` 转为 `Onboarded`。

证书轮换也按通信设计实施：设备提交 `currentCertificateId`，云端返回新的 `certificateId`、`certificatePem`、`privateKey`、`effectiveDate` 和 `expiryDate`。新证书成功 Heartbeat 后再停用旧证书。

由于该契约要求云端处理私钥，必须增加以下补偿控制：私钥只在 AWS IoT 创建时出现一次；不得写入数据库、日志、Trace 或审计明文；待领取证书包只能使用 KMS 信封加密短期保存；只允许对应 Onboarding Token 或旧设备证书领取；领取成功或新证书 Heartbeat 后立即销毁；丢失后重新签发而不是找回旧私钥。

CSR 发证更符合私钥不离开设备的安全原则，但它改变了通信设计中的请求/响应，当前只能作为后续协议变更建议，不能作为 V1 默认实现。

**后续扩容选择**

设备量进入批量生产后，可以根据制造能力选择工厂预置一机一证并使用 JITP/JITR，或使用 AWS IoT Fleet Provisioning。该选择不影响试运营阶段的 Topic 和业务 API。

### 4.4 设备 REST API 的认证入口需要拆分

**问题**

Onboarding API 使用 Token，而已入网设备 API 使用 X.509 mTLS。两类接口放在同一个强制 mTLS 的域名或监听器上会产生认证冲突。

**解决方案**

使用独立入口：

| 域名 | 用途 | 认证方式 |
|---|---|---|
| `onboard-api.example.com` | Onboarding Request/Status | 一次性 Token + 限流 |
| `device-api.example.com` | Sync、证书状态/轮换、Media 上传申请 | X.509 mTLS |
| `api.example.com` | 业务 API 和管理 API | Cognito JWT |

设备 API 与业务 API 在代码层可以复用领域服务，但在网络入口、认证、限流和日志上保持隔离。

### 4.5 原始遥测与 RDS 存储边界不清

**问题**

设备文档要求 Telemetry 在 RDS 中只保存聚合结果，AWS 文档又设计了原始 telemetry 时序表。即使只有 10 台设备，长期双写也会增加维护复杂度，并为以后扩容留下错误的数据模型。

**解决方案**

| 数据类型 | RDS | S3 原始归档 |
|---|---|---|
| Heartbeat | 只保存每设备最新状态 | 否 |
| Telemetry | 聚合摘要，不长期保存原始明细 | 是 |
| ESG Report | 是 | 是 |
| Alarm/Event/Tamper | 是 | 是 |
| ACK | 命令状态和结果 | 可选 |
| OTA 状态 | 是 | 可选 |
| Media | 只保存元数据 | 文件本体进入独立 S3 桶 |

试运营阶段使用 RDS PostgreSQL 单 AZ 小规格即可；正式生产再启用 Multi-AZ、PITR 和更长备份。不得以扩大 RDS 实例代替数据分层设计。

### 4.6 S3 小文件与不可变归档

**问题**

IoT Rules 直接把每条消息写成一个 S3 对象，会产生大量小文件，不利于 Athena 查询。10 台设备时成本不高，但会形成难以平滑扩容的数据布局。

**解决方案**

试运营阶段采用以下任一方式，优先选择方案 A：

- 方案 A：IoT Rules → Ingress SQS → Ingestion Lambda；业务入库与 `outbox_event` 在同一数据库事务中提交，再由 Outbox Publisher → Archive SQS → Archive Lambda，按批次把记录合并为 NDJSON/GZIP 后写入 S3；
- 方案 B：IoT Rules → Amazon Data Firehose → S3，使用缓冲、动态分区和 Parquet 转换。

S3 前缀建议为：

```text
raw/topic_type={type}/customer_id={customerId}/year={yyyy}/month={mm}/day={dd}/hour={hh}/part-*.json.gz
```

归档记录必须包含原始 payload、接收时间、Topic、设备 ID、Customer ID、Schema 版本和云端校验结果。试运营阶段可先使用 S3 Versioning；只有在业务确认需要 7 年不可删除留存后，再启用 Object Lock Compliance。Object Lock 的保留期和合规模式启用后不应随意更改。

### 4.7 “绝对不丢数据”缺少端到端条件

**问题**

SQS 和 S3 都不能弥补设备断网时未持久化的数据。IoT Rule 的多个 Action 也不是跨服务事务。当前设计不足以证明任何情况下都不会丢失消息。

**解决方案**

将非功能目标改为“可验证的数据完整性”：

- 设备端按协议持久化未确认消息；具体实现由设备团队负责；
- 云端采用 QoS 1、SQS 至少一次消费和数据库幂等；
- 使用 `seq` 检测设备消息缺口；
- 建立 `ingestion_gap` 和 `replay_job` 数据模型；
- Archive 与业务入库分别记录处理状态；
- 支持按设备、时间范围和序号范围执行重放；
- 对 DLQ、Rule Error Action、序号缺口和归档失败设置告警。

验收时应进行断网补报、重复消息、乱序、脏数据、Worker 故障和 30 倍重连突发测试。

### 4.8 ESG Hash 不能单独证明真实性

**问题**

原协议中的普通 SHA-256 Hash 可以检测内容变化，但攻击者修改数据后可以重新计算 Hash，因此不能独立证明消息来自可信设备。

**解决方案**

试运营阶段至少实现：

- TLS 双向认证；
- 云端记录证书 ID、接收时间和原始消息；
- 对归档批次生成 Manifest 和服务端 SHA-256；
- S3 Versioning、访问日志和 CloudTrail；
- 关键 ESG Report 保留设备端签名扩展字段。

如果数据用于第三方正式核证，应在下一阶段引入设备私钥签名、规范化 JSON、可信时间源、签名验证和证据链管理，不能仅依靠 `audit.hash`。

### 4.9 Remote Command 的安全边界不足

**问题**

START、STOP、HEATING_ON 等命令可能影响实体设备。仅发布 MQTT 消息和等待 ACK 不足以满足安全要求。

**解决方案**

- 命令必须先写数据库，再发布 MQTT；
- 校验 Customer、用户角色、设备状态、许可证 Entitlement 和命令白名单；
- Command Payload 保留通信设计规定的 `command`、`requestedBy`、`requestTime`、`timeoutSec` 和 `remarks`，`meta.id` 作为 `commandId`；云端内部据此计算 `expiresAt`；
- 超时命令不得在设备恢复在线后继续执行；
- 对高风险命令配置二次确认或审批；
- ACK 只更新对应 `commandId`，重复 ACK 保持幂等；
- 所有请求、审批、发布、ACK 和失败都写入审计日志。

### 4.10 OTA 设计缺少签名与灰度控制

**问题**

只有 SHA-256 校验只能检测传输错误，不能证明固件发布者身份；同时缺少灰度批次、暂停和回滚控制。

**解决方案**

- 固件包上传 S3 后进行服务端病毒扫描和签名校验；
- 保存版本、设备型号、SHA-256、数字签名、大小和发布说明；
- 预签名 URL 有效期建议 15 分钟；
- OTA Campaign 支持 1 台试点、批次扩大、暂停、取消和失败重试；
- 云端记录下载、安装和回滚状态；
- 云端只负责分发和状态机，设备端校验、安装和回滚实现仍由设备团队负责。

### 4.11 Customer 隔离和管理员权限需要落到数据层

**问题**

仅在 API 参数中传递 `customerId` 不能形成可靠隔离。管理员后台还需要区分平台超级管理员、运营人员、审计人员和 Customer 管理员。

**解决方案**

- Customer 用户和平台管理员使用独立 Cognito App Client 或独立 User Pool；
- JWT 中只保存身份和角色，不信任客户端提交的 Customer 范围；
- 后端根据 `sub` 查询授权范围，并自动注入 `customerId` 查询条件；
- 所有核心业务表必须含 `customer_id`；如果实现沿用 `tenant_id`，需在数据字典中声明其语义等同于 Customer ID；
- 平台级跨 Customer 查询仅允许明确的管理员角色；
- 管理员强制 MFA；
- 所有跨 Customer 操作和权限变更必须记录审计日志。

### 4.12 试运营阶段不应照搬五个常驻 Fargate 服务

**问题**

对 10 台设备部署多个常驻 Worker、API 和 SSR 容器，会增加固定成本、部署单元和运维复杂度，但不能显著提高试运营质量。

**解决方案**

试运营阶段建议：

- SQS 消费与聚合使用 Lambda；
- 业务 API 和管理 API 使用一个模块化云端应用，按领域分模块而不是过早拆成微服务；
- 管理后台采用静态 Web 资源托管到 S3 + CloudFront，API 单独部署；
- 只有出现持续高 CPU、长任务、稳定高并发或 Lambda 成本拐点时，再迁移到 ECS Fargate；
- 通过 CDK、共享 DTO、事件格式和服务接口保持迁移能力。

### 4.13 通信设计内部需要冻结的歧义

通信设计是第一事实源，但其中仍存在少量内部不一致，不能由开发团队自行猜测：

| 歧义 | 采用的试运营解释 | 待确认事项 |
|---|---|---|
| Tier 定义将 Command 归为 Tier 3，但 Topic Catalog 的 Tier 列全部显示 Tier 1 | 以 Payload 结构和具体示例为准：Telemetry/Report/Tamper 使用 `meta + audit + data`，Command 使用 `meta + data` | 修正 Topic Catalog 的 Tier 列 |
| Operational State Machine 只有 Active/Suspended/Retired，但 Sync 内容又包含 Maintenance | 云端保留独立 `Maintenance` 状态；行为暂按 Suspended 的限制策略执行，但允许维护相关操作 | 确认 Maintenance 的完整行为矩阵 |
| Onboarding/Rotation 返回私钥，但没有定义丢包后的重复领取语义 | 使用短期加密证书包和一次性领取状态；丢失后重新签发 | 确认领取有效期和最多领取次数 |
| Device User Sync 示例含 `passwordHash` | 仅允许下发设备本地账号的专用加盐验证值，禁止使用 Cognito 或云端用户密码 Hash | 确认设备端支持的 Hash/KDF 格式 |
| Topic Catalog 定义了 Media，但 Retention Policy 未列 Media | RDS 只保存 Media 元数据；文件本体进入独立受控 S3 Bucket | 确认 Media 文件和元数据保留期 |

### 4.14 Device Sync 与 Deactivate 不得遗漏

AWS 方案只概括了设备影子和配置同步，但通信设计明确要求：

- `POST /api/v1/device/sync`：同步 Customer/Site Assignment、Device Alias、License、Entitlements、Device Users、Configuration 和 Operational Status；
- `POST /api/v1/device/deactivate`：设备退役流程中的停用确认；
- Active 设备每 5 分钟 Sync；
- Suspended 设备每 15 分钟 Sync；
- 离线恢复后立即 Sync；
- 收到同步类 MQTT Notification 后立即 Sync。

这两个 API、调用频率和返回域是主参考文档的强制要求，不能用 Device Shadow 或管理后台轮询替代。

## 5. 试运营阶段推荐架构

```text
设备 MQTT/mTLS
    → AWS IoT Core
    → IoT Rules
        → Ingress SQS → Ingestion Lambda
            → RDS（业务数据 + Outbox）
            → Outbox Publisher → Archive SQS → Archive Lambda/Firehose
                → S3 Raw Archive
        → Rule Error Queue / DLQ

设备 REST
    → Onboarding API（Token）
    → Device API（mTLS）
    → API Gateway + Lambda

业务与管理后台
    → CloudFront + S3 静态前端
    → API Gateway
    → Cognito JWT Authorizer
    → Business/Admin Lambda
    → RDS PostgreSQL + S3

监控与审计
    → CloudWatch + CloudTrail + SNS
```

## 6. 扩容触发条件

试运营架构不按设备数量机械升级，而按监控指标触发：

| 指标 | 建议触发动作 |
|---|---|
| SQS 最老消息持续超过 60 秒 | 提高 Lambda 并发或优化批量写入 |
| RDS CPU 持续超过 60% | 优化查询、索引和连接，再评估升配 |
| 原始数据超过约 100GB/月 | 引入 Firehose + Parquet，优化 Athena |
| Lambda 单任务接近 15 分钟或有长驻连接 | 迁移对应 Worker 到 ECS Fargate |
| API 稳定高并发且冷启动影响 SLA | 部署 ECS Fargate 或配置 Provisioned Concurrency |
| 设备进入批量制造 | 切换 JITP/JITR 或 Fleet Provisioning |
| 正式 SLA 和审计要求生效 | RDS Multi-AZ、WAF、Object Lock、跨区域备份 |

## 7. 修订后的实施优先级

### 必须在首台真实设备接入前完成

1. Topic、Payload Schema、QoS 和错误码冻结；
2. Onboarding、一次性证书包和证书轮换流程；
3. IoT Policy 的单设备最小权限；
4. 幂等键、序号缺口和命令状态机；
5. RDS/S3 数据边界；
6. 设备模拟器和协议一致性测试。

### 必须在 10 台设备试运营前完成

1. Customer、站点、设备、许可证和用户管理；
2. 告警、事件、ESG 报告和管理操作审计；
3. DLQ、归档失败、证书到期和设备离线告警；
4. OTA 灰度批次和命令权限；
5. 断网补报、重复、乱序、重连风暴和恢复演练；
6. 数据备份和试运营运维手册。

### 可在正式商业化前完成

1. Firehose/Parquet 数据湖优化；
2. RDS Multi-AZ 和跨区域备份；
3. WAF、正式安全测试和合规加固；
4. 批量制造证书体系；
5. 多级审批和更细粒度 RBAC；
6. 正式 ESG 数字签名和第三方核证接口。

## 8. 结论

设备数量降为 10 台后，容量和 AWS 成本不再是试运营阶段的主要风险，原方案无需按 1,000 台基准部署全部固定资源。但协议、证书、幂等、远程命令、数据归档和多租户隔离仍然必须在早期正确实现。推荐使用轻量 Serverless 架构完成试运营，并通过 CDK、标准事件和清晰的数据分层保留未来迁移到 ECS Fargate、Firehose 和 Multi-AZ 数据库的能力。

## 9. 参考资料

- [Device-Cloud Communication Design](./Device-Cloud%20Communication%20Design.pdf)
- [厨余设备 ESG 物联网平台 AWS 架构设计与技术方案](./厨余设备ESG物联网平台AWS架构设计与技术方案.docx)
- [AWS IoT Core MQTT 与 QoS](https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html)
- [AWS IoT CreateKeysAndCertificate](https://docs.aws.amazon.com/iot/latest/apireference/API_CreateKeysAndCertificate.html)
- [API Gateway Mutual TLS](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-mutual-tls.html)
- [Amazon Data Firehose 数据交付](https://docs.aws.amazon.com/firehose/latest/dev/basic-deliver.html)
