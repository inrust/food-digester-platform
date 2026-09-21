# AWS 云端业务与管理后台开发实施方案

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| 项目名称 | 厨余设备 ESG 物联网平台 |
| 文档范围 | AWS 云端业务系统、设备云端接入、运营管理后台 |
| 目标阶段 | 最多 10 台设备的早期试运营 |
| 推荐技术栈 | TypeScript、Node.js、AWS CDK、Lambda、API Gateway、RDS PostgreSQL、S3、Cognito、Next.js/React |
| 不包含 | 设备固件、Android Edge、本地数据库、本地离线队列、设备安装施工 |

### 1.1 需求来源与优先级

本实施方案遵循以下强制优先级：

1. 《Device-Cloud Communication Design》是业务模型、生命周期、MQTT Topic、Payload、QoS、REST API、同步流程、命令目录和数据保留策略的第一事实源；
2. 《厨余设备 ESG 物联网平台 AWS 架构设计与技术方案》是 AWS 服务选择和工程实现参考；
3. 两者冲突时采用《Device-Cloud Communication Design》；
4. AWS 存在硬性限制时，必须登记为“技术适配”，经协议双方确认后实施，不允许代码自行改变设备契约；
5. 本文中的 Customer 是通信设计定义的商业主体。`tenant` 只表示多租户隔离机制，不是另一个业务实体；数据库、JWT 或日志若使用 `tenantId`，其语义必须等同于 `customerId`。

当前唯一已批准的协议级技术适配是：通信设计中 ESG Report、Tamper 和 Command 的 QoS 2，在 AWS IoT Core 上实施为 QoS 1，并通过消息 ID、序号、Command ACK 和幂等处理保持业务可靠性。

对通信设计的复核还识别出六项协议问题：MQTT Payload 规范化、Retired 过渡期认证、OTA 状态回传通道、License/OTA 归档语义、Onboarding 超时语义和 Configuration 扩展字段。它们分别进入 DEC-013～018 决策门禁，现均已冻结为 1.0.0。

## 2. 建设目标

建设一个能够支持最多 10 台真实厨余处理设备试运营的 AWS 云端系统，完成以下闭环：

1. 设备提交入网申请，管理员审批并完成证书发放；
2. 设备通过 MQTT over TLS 上报 Heartbeat、Telemetry、ESG Report、Alarm、Event、ACK、Tamper 和 Media 元数据；
3. 云端可靠接收、校验、归档和聚合设备数据；
4. 云端按 Customer → Site → Device 的权威业务层级管理客户、站点、设备、许可证、配置和设备用户；
5. 管理员可以查看设备状态、告警、ESG 数据并执行授权的远程命令；
6. 管理员可以上传 OTA 包、创建灰度批次并查看升级结果；
7. 所有关键操作和数据处理均可审计、可告警、可重试和可重放；
8. 架构能够在不改变设备协议和核心业务模型的情况下扩展到更多设备。

## 3. 范围界定

### 3.1 本阶段包含

- AWS 账号与环境基座；
- IoT Core、Thing、证书和 IoT Policy；
- Onboarding、证书签发、状态查询和证书轮换云端 API；
- 通信设计规定的统一 Device Sync 和 Deactivate API；
- MQTT Topic 路由、消息校验、幂等、SQS、DLQ 和数据归档；
- 客户、站点、设备、许可证、Entitlement、配置和设备用户管理；
- Heartbeat、Telemetry、ESG Report、Alarm、Event 和 Tamper 数据处理；
- Remote Command、ACK 状态机；
- OTA 包管理、批次管理和状态跟踪；
- Media 上传凭证和元数据管理；
- 平台管理员、运营人员、审计人员和 Customer 管理员权限；
- 管理后台 Web 页面；
- CloudWatch 监控告警、CloudTrail 和业务审计；
- AWS CDK、CI/CD、自动化测试、试运营上线和运维文档。

### 3.2 本阶段不包含

- 设备传感器采集和控制程序；
- Android Edge UI、服务、本地数据库和本地账号管理；
- 设备本地断网缓存的具体实现；
- OTA 包在设备端的校验、安装和回滚实现；
- 摄像头采集、视频编码和设备端上传实现；
- 面向普通客户的完整 SaaS 门户或移动应用；
- 第三方 ESG 核证、财务级碳核算认证；
- 7×24 人工运维服务和正式等保/ISO 认证。

### 3.3 云端与设备端的责任边界

云端负责发布并维护协议、Schema、证书流程、Endpoint、错误码和测试工具。设备团队负责按协议实现 MQTT/REST 客户端、私钥保护、本地持久队列、命令安全检查、OTA 安装及真实设备响应。

双方必须共同完成协议一致性测试和真实设备联调；设备端不在开发范围内，不代表设备端无需配合验收。

## 4. 架构原则

1. **试运营轻量化**：10 台设备不部署不必要的常驻微服务和高规格数据库；
2. **协议生产化**：Topic、Schema、身份、幂等和审计从第一天按可扩展方式设计；
3. **数据分层**：RDS 保存业务事实和聚合，S3 保存原始事实记录；
4. **至少一次处理**：不依赖恰好一次投递，以幂等和对账保证结果正确；
5. **身份不可伪造**：Customer 和设备身份从证书及服务端台账取得，不信任 Payload 自报；
6. **模块化单体优先**：试运营阶段按领域分模块，不急于拆成多个微服务；
7. **基础设施即代码**：所有环境使用 CDK 可重复部署；
8. **默认最小权限**：设备、用户、Lambda 和 CI/CD 都只获得必要权限。

## 5. 推荐 AWS 架构

### 5.1 逻辑架构

```text
┌──────────────────── 设备接入 ────────────────────┐
│ Device ── MQTT/mTLS ── AWS IoT Core             │
│ Device ── HTTPS Token ── Onboarding API          │
│ Device ── HTTPS mTLS ── Device API               │
└──────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────── 消息处理 ────────────────────┐
│ IoT Rules ── Ingress SQS ── Ingestion Lambda    │
│                    ├─ RDS Business Data          │
│                    └─ RDS Outbox                 │
│ Outbox Publisher ── Archive SQS                 │
│                    └─ Archive Lambda ── S3       │
│ Rule Error SQS / DLQ ── Alarm                   │
│ EventBridge Scheduler ── Summary Lambda          │
└──────────────────────────────────────────────────┘
                      │
                      ▼
┌────────────────── 业务与管理面 ──────────────────┐
│ Admin Web ── CloudFront ── S3                   │
│ Admin/Business API ── API Gateway ── Lambda      │
│ Cognito ── JWT/MFA                               │
│ RDS PostgreSQL ── 业务数据、状态、聚合、审计      │
│ S3 ── 原始数据、OTA、Media、报表导出              │
└──────────────────────────────────────────────────┘
                      │
                      ▼
┌────────────────── 安全与运维 ────────────────────┐
│ CloudWatch / CloudTrail / SNS / Secrets Manager  │
│ CDK / GitHub Actions OIDC                        │
└──────────────────────────────────────────────────┘
```

### 5.2 环境划分

| 环境 | 用途 | 数据 |
|---|---|---|
| dev | 日常开发、自动化测试 | 模拟数据，不使用生产证书 |
| staging | 真实设备联调、验收演练 | 测试设备和脱敏数据 |
| prod | 最多 10 台设备试运营 | 正式业务数据 |

三个环境使用独立资源前缀、数据库、S3 Bucket、Cognito User Pool、IoT Policy 和密钥。生产设备证书不得连接 dev/staging。

### 5.3 试运营与正式生产差异

| 项目 | 10 台试运营 | 规模化生产 |
|---|---|---|
| 计算 | Lambda | 根据负载保留 Lambda 或迁移 ECS Fargate |
| RDS | 小规格、单 AZ、自动备份 | Multi-AZ、RDS Proxy、只读副本按需 |
| 原始归档 | Archive Lambda 合并 NDJSON/GZIP | Firehose、Parquet、动态分区 |
| 管理 Web | S3 + CloudFront 静态部署 | 保持不变或按 SSR 需求转容器 |
| 证书 | Token 审批 + 一次性证书包 | 只有协议变更后才评估 CSR、JITP/JITR 或 Fleet Provisioning |
| 防护 | API 限流、最小权限 | WAF、正式渗透测试、跨区域备份 |

## 6. 技术栈与代码组织

### 6.1 技术栈

| 层面 | 选型 |
|---|---|
| 语言 | TypeScript 5.x、Node.js 24 LTS |
| Monorepo | pnpm workspaces + Turborepo |
| API | NestJS 或轻量 Lambda Handler；统一 OpenAPI |
| 数据校验 | Zod，JSON Schema 对外发布 |
| 数据访问 | Prisma；复杂分区和索引使用显式 SQL Migration |
| 管理前端 | Next.js/React；管理系统优先静态输出 |
| 基础设施 | AWS CDK TypeScript |
| 测试 | Vitest、Supertest、Playwright、LocalStack/真实 AWS 测试环境 |
| 日志 | 结构化 JSON，包含 traceId、customerId、deviceId、messageId |

### 6.2 推荐目录

```text
apps/
  cloud-api/              # Onboarding、Device、Business、Admin API
  admin-web/              # 管理后台 Web
  ingestion-worker/       # SQS 消费和业务入库
  archive-worker/         # S3 原始归档
  summary-worker/         # ESG 小时/日聚合
packages/
  contracts/              # MQTT、REST DTO、JSON Schema、错误码
  domain/                 # 状态机和领域规则
  database/               # Prisma Schema、Migration、Repository
  aws-clients/            # IoT、S3、SQS、Cognito 封装
  observability/          # 日志、指标、Trace
infra/
  bin/
  lib/
    network-stack.ts
    identity-stack.ts
    iot-stack.ts
    data-stack.ts
    application-stack.ts
    monitoring-stack.ts
```

## 7. 通信协议收口

### 7.1 MQTT Topic

```text
bnx/device/{deviceId}/heartbeat
bnx/device/{deviceId}/telemetry
bnx/device/{deviceId}/report
bnx/device/{deviceId}/alarm
bnx/device/{deviceId}/event
bnx/device/{deviceId}/ack
bnx/device/{deviceId}/tamper
bnx/device/{deviceId}/media

bnx/device/{deviceId}/cmd
bnx/device/{deviceId}/ota
bnx/device/{deviceId}/notification
```

设备只允许发布自己的上行 Topic，只允许订阅自己的下行 Topic。策略中的 `deviceId` 必须与证书绑定的 Thing Name 对应。

通信设计 Topic Catalog 的实施矩阵如下。`规定 QoS` 来自主参考文档，`AWS 实施 QoS` 是实际部署值：

| Topic Type | 方向 | 频率 | 规定 QoS | AWS 实施 QoS | Payload |
|---|---|---|---:|---:|---|
| Heartbeat | Device → Cloud | 每 60 秒 | 1 | 1 | `meta + data` |
| Telemetry | Device → Cloud | 每 10～60 秒可配置 | 1 | 1 | `meta + audit + data` |
| ESG Report | Device → Cloud | 每周期/每小时/每日 | 2 | 1 | `meta + audit + data` |
| Alarm | Device → Cloud | 事件触发 | 1 | 1 | `meta + data` |
| Event | Device → Cloud | 事件触发 | 1 | 1 | `meta + data` |
| ACK | Device → Cloud | 命令执行后 | 1 | 1 | `meta + data` |
| Tamper | Device → Cloud | 事件触发 | 2 | 1 | `meta + audit + data` |
| Media | Device → Cloud | 事件触发 | 1 | 1 | `meta + data` |
| Command | Cloud → Device | 按需 | 2 | 1 | `meta + data` |
| OTA | Cloud → Device | 按需 | 1 | 1 | `meta + data` |
| Notification | Cloud → Device | 按需 | 1 | 1 | `meta + data` |

QoS 2 → 1 只适用于 AWS IoT Core 技术适配，不能因此删除通信设计规定的 ACK、超时、审计和业务确认机制。

### 7.2 统一消息信封

```json
{
  "meta": {
    "id": "TEL-DEV001-10001",
    "ts": "2026-08-01T10:00:00Z",
    "seq": 10001,
    "schemaVer": "1.0"
  },
  "audit": {
    "hash": "tier2-payload-sha256"
  },
  "data": {}
}
```

规则：

- `meta.id` 全局唯一，最大长度和字符集在 Schema 中固定；
- `meta.ts` 必须为 UTC ISO 8601；
- `meta.seq` 对设备上行运行数据必填，并在同一设备、同一消息类型内单调递增；Cloud → Device 的具体示例未包含 `seq`，Command 使用 `meta.id/commandId` 幂等，是否为其他下行消息补充 `seq` 需在协议冻结时确认；
- 通信设计示例未定义 `schemaVer`，因此现有 V1 消息缺省时云端按 `1.0` 处理；只有双方更新通信设计后才将其改为设备必填；
- Telemetry、ESG Report 和 Tamper 按具体 Payload 定义必须包含 `audit.hash`，其他 Topic 不强制；
- 云端补充 `receivedAt`、`deviceId`、`customerId`、`topicType` 和证书标识；
- Payload 不接受设备提交的可信 `customerId/tenantId`；
- 超过允许时钟偏差的消息仍可归档，但标记 `clockSkew` 并告警。

### 7.3 QoS 和消息大小

- AWS 实际上行和下行均使用 QoS 1；其中 ESG Report、Tamper 和 Command 是已登记的 QoS 2 → 1 技术适配；
- 单条 JSON 建议不超过 32KB；媒体文件不通过 MQTT 传输；
- 重复消息必须返回同样的处理结果，不得产生重复业务记录；
- 未识别 Schema 进入隔离队列，不直接丢弃。

### 7.4 Payload 字段基线

JSON Schema 必须以通信设计中的具体字段和示例为基线。云端不得因 AWS 方案只示例 `ts/metrics/schemaVer` 而缩减字段。

| 消息 | `data` 必须覆盖的字段基线 |
|---|---|
| Heartbeat | `deviceStatus`、`uptimeSeconds`、`firmwareVersion`、`operationalStatus`、`machineRunning`、`machineMode`、`licenseStatus`、`licenseExpiryDate`、`networkType`、`networkStatus`、`signalStrength`、CPU/内存/存储使用率、传感器状态、证书状态、Tamper 状态 |
| Telemetry | `feedingWeightKg`、`chamberWeightKg`、`dischargeWeightKg`、`humidityPct`、`ambientTempC`、`heatTemperatureC`、`siloTemperatureC`、`powerConsumptionKw`、`o2Pct`、`co2Ppm`、`ch4Ppm`、`n2oPpm`、`currentAmp` |
| ESG Report | `reportType`、`periodStartTime`、`periodEndTime`、投料/出料/减量、周期数、处理时长、耗电量、平均功率、平均气体值、`carbonReductionKg`、`carbonReductionMethod`、`dataCompletenessPct`、`missingRecordCount` |
| Alarm | `code`、`category`、`severity`、`status`、`detectedTime`、`component`、`currentValue`、`threshold`、`unit`、`message`、`recommendedAction` |
| Event | `eventType`、`userId`、`username`、`source`、`remarks` |
| ACK | `commandId`、`command`、`result`、`executeTimeMs`、`errorCode`、`message` |
| Tamper | `eventType`、`severity`、`component`、`details`、`actionTaken` |
| Media | `mediaType`、`captureTime`、`fileName`、`objectPath`、`sizeKb`、`durationSec` |
| Command | `command`、`requestedBy`、`requestTime`、`timeoutSec`、`remarks` |
| OTA | `version`、`packageType`、`downloadUrl`、`sha256`、`mandatory`、`scheduledTime` |
| Notification | `type`、`priority`、`title`、`message`、`action` |

Heartbeat 表格明确给出了大部分类型和必填性，但其他 Topic 多数只给出字段与示例，不能笼统声称“必填性、枚举和单位均已由通信设计定义”。需要增加 `schemaVer`、接收时间或云端追踪字段时，只能作为向后兼容扩展。

### 7.5 Payload 规范化门禁

DEC-013@1.0.0 已冻结以下事项，MQTT Schema V1 必须以此表为准：

| 未决项 | 源稿冲突/缺口 | 冻结要求 |
|---|---|---|
| Heartbeat 结构 | 字段表使用扁平字段，JSON 示例使用 `network/system/machine/sensorStatus` 嵌套对象 | 正式结构为扁平字段；旧嵌套结构兼容至 `2026-12-03T09:46:26Z`，入口转换，期满拒绝 |
| 存储使用率 | `storageUsagePct` 行的 Type/Required 列错位 | 可选 `number`，范围 0～100，禁止 `null` |
| 电机电流 | 字段表为 `currentAmp`，示例为 `motorCurrentAmp` | 正式名 `currentAmp`；旧名兼容至同一截止时间 |
| Machine Mode | 源稿使用 `DISCHARING` | 正式值 `DISCHARGING`；旧拼写兼容至同一截止时间 |
| 非 Heartbeat 字段 | 多数未提供类型、必填性、范围、精度和 Null 语义 | 未明确必填的字段保持可选；存在时严格校验，禁止 Null、未知字段和设备声明身份字段 |
| `audit.hash` | 仅说明 SHA-256，未定义规范化方式和覆盖范围 | `SHA-256(RFC8785({meta,data}))`，UTF-8、小写 hex；防重放由 mTLS、seq 和收据幂等承担 |

CT-03 Schema、Fixture、生成类型和 BE-IOT-02 校验管线均须引用 `DEC-013@1.0.0`；兼容期后旧格式必须按协议违规隔离。

## 8. 设备身份与 Onboarding

### 8.1 状态机

```text
PendingOnboarding
  ├─ Rejected
  └─ OnboardingApproved
         └─ Onboarded
               └─ Assigned
                     └─ Licensed
                           └─ Active
                                 ├─ Suspended
                                 └─ Retired
```

状态变化必须由领域服务执行，禁止直接更新数据库状态字段。每次变化写入 `device_state_history` 和 `audit_log`。AWS Thing/证书创建是 `OnboardingApproved → Onboarded` 中的内部 Provisioning 步骤，不得增加通信设计中不存在的外部 `Provisioned` 状态。

通信设计的设备行为矩阵必须落实为云端授权策略：

| 功能 | Active | Suspended | Retired |
|---|---|---|---|
| Local Login、Heartbeat、Telemetry、Alarm Reporting、License Sync | 允许 | 允许 | 禁止 |
| Remote Control | 允许 | 允许，但仍执行命令级权限和安全检查 | 禁止 |
| Device Processing、ESG Reporting | 允许 | 禁止 | 禁止 |
| OTA Updates、User Synchronization | 允许 | 允许 | 禁止 |

Retired 是永久退役状态，不允许重新激活。Suspended → Active 必须由管理员批准并记录问题已解决。

生命周期转换严格采用通信设计：

| From | To | 触发者/前提 |
|---|---|---|
| PendingOnboarding | OnboardingApproved | CMP Super Admin 审批且设备校验通过 |
| PendingOnboarding | Rejected | CMP Super Admin 拒绝且记录失败原因 |
| OnboardingApproved | Onboarded | 证书安装完成并收到首个 Heartbeat |
| Onboarded | Assigned | CMP Super Admin 分配已存在的 Customer 和 Site |
| Assigned | Licensed | 许可证已签发并同步到设备 |
| Licensed | Active | 设备本地验证许可证有效 |
| Active | Suspended | 管理/策略动作并记录原因 |
| Suspended | Active | 管理员批准恢复且问题已解决 |
| Active/Suspended | Retired | CMP Super Admin 批准永久退役 |

### 8.2 Onboarding API

| API | 方法 | 认证 | 说明 |
|---|---|---|---|
| `/api/v1/device/onboarding/request` | POST | Onboarding Token | 提交序列号、型号、硬件版本、制造商和生产日期 |
| `/api/v1/device/onboarding/status` | GET | Onboarding Token | 查询审批状态和发证结果 |
| `/api/v1/admin/onboarding/{id}/approve` | POST | 管理员 JWT + MFA | 审批并触发发证；不分配 Customer/Site |
| `/api/v1/admin/onboarding/{id}/reject` | POST | 管理员 JWT + MFA | 拒绝并填写原因 |

Token 必须一次一机、可撤销、有有效期并只保存 Hash。接口应限制每个 Token/IP 的调用频率。

正常设备只提交一次 Onboarding Request；进入 `PENDING` 后每 30 秒查询 Onboarding Status，直至 `APPROVED` 或 `REJECTED`。

`onboarding/status` 的外部响应状态按通信设计映射：

- `PENDING`：等待管理员审批；
- `REJECTED`：返回拒绝原因；
- `APPROVED`：返回 Device ID、Certificate Package、MQTT 配置和初始配置。

必须覆盖通信设计列出的负向案例：序列号不存在、设备已经 Onboarded、管理员拒绝、设备证书安装失败。证书安装失败时不得直接标记 Onboarded；DEC-003@1.0.0 只允许一次成功领取，密文包最长保存 24 小时，响应不确定时吊销未确认新证书并重新签发，不恢复旧包。DEC-017@1.0.0 冻结证书包存储后 24 小时首个合法 Heartbeat 硬截止：截止前包过期仍按 DEC-003 撤证重签；边界到达后内部申请置 TIMED_OUT、外部映射 REJECTED/ONBOARDING_TIMEOUT，撤销未确认新证书并销毁密文包，设备回到既有 PendingOnboarding；迟到 Heartbeat 拒绝，超时后不自动重签，必须使用新 Token 重新申请。

### 8.3 发证流程

1. 设备按通信设计提交 `serialNumber`、`model`、`hardwareVersion`、`manufacturer` 和 `manufactureDate`；
2. 云端验证 Onboarding Token、序列号和设备库存；
3. API 返回 `requestId` 和 `PENDING`，设备每 30 秒查询状态；
4. 管理员审批；
5. 云端创建 Device ID 和 AWS IoT Thing；
6. 调用 AWS IoT `CreateKeysAndCertificate` 创建证书包并附加设备专属 IoT Policy；
7. `onboarding/status` 按通信设计返回 `deviceId`、`certificatePem`、`privateKey`、MQTT Endpoint 和初始配置；
8. 设备安装证书并连接 MQTT；
9. 首次 MQTT Heartbeat 成功后标记 Onboarded。

证书私钥不得写入数据库、日志、Trace 或普通审计字段。待领取证书包使用 KMS 信封加密保存不超过 86400 秒，只允许一次成功领取；服务端提交成功响应后立即销毁，响应不确定、包丢失或过期时吊销未确认新证书并重新签发，不找回旧私钥。CSR 模式只作为后续协议升级建议，不能作为 V1 默认实现。

### 8.4 证书轮换

| API | 方法 | 认证 | 说明 |
|---|---|---|---|
| `/api/v1/device/certificate/status` | GET | mTLS | 查询证书状态和到期时间 |
| `/api/v1/device/certificate/rotate` | POST | mTLS | 提交 `currentCertificateId`，取得新证书包 |

轮换响应按通信设计返回新的 `certificateId`、`certificatePem`、`privateKey`、`effectiveDate` 和 `expiryDate`。轮换时保留有限双证书窗口，新证书产生有效 Heartbeat 后停用旧证书。证书到期前 30 天、14 天和 7 天告警。

设备每天调用一次 Certificate Status；Certificate Rotate 只在云端通知或证书接近到期时调用，不得周期性无条件轮换。

API Gateway mTLS 完成 CA 链校验后，Device API 仍必须根据客户端证书序列号或证书指纹查询 `device_certificates`，确认该证书处于 Active 状态且属于请求中的设备。只通过 CA 校验不能替代应用层设备白名单。

### 8.5 统一设备同步与停用确认

以下设备 API 是通信设计的强制接口：

| API | 方法 | 认证 | 用途 |
|---|---|---|---|
| `/api/v1/device/sync` | POST | X.509 + mTLS | 从 CMP 获取完整的单一事实源快照 |
| `/api/v1/device/deactivate` | POST | X.509 + mTLS | 设备退役流程中的停用确认 |

Sync 请求至少包含 `lastSyncTime`。响应必须覆盖：

- Assignment：`customerId/customerName`、`siteId/siteName`、Authorization Window；
- Device Metadata：Device Alias；
- License：状态、有效期、Entitlements 和签名；
- Device Users：最新授权设备操作员；
- Configuration：Heartbeat、Telemetry、Camera Refresh、温度阈值等最新有效配置；
- Operational Status：`Active`、`Maintenance`、`Suspended` 或 `Retired`。

V1 Sync 始终返回上述完整事实快照。响应可携带版本号或 ETag 供设备判断是否更新本地缓存，但不得返回 `304` 或省略必要域；`lastSyncTime` 不得在没有版本化协议的情况下被解释为增量裁剪条件。

通信设计示例明确出现的 Configuration 字段只有 `heartbeatInterval`、`telemetryInterval`、`cameraRefreshInterval` 和 `temperatureThreshold`。DEC-018@1.0.0 已将 V1 冻结为这四个字段：Heartbeat 10～900 秒（默认 60）、Telemetry 5～3600 秒（默认 30）、Camera Refresh 1～1440 分钟（默认 1）、温度阈值 0～120 °C（默认 80）。图像尺寸/上传间隔、旋转 M/N、电机过载电流、最低/最高加热温度、语言和网络字段不进入 V1。

调用频率严格采用通信设计：

| 场景 | 调用频率 |
|---|---|
| Active | 每 5 分钟 |
| Suspended | 每 15 分钟 |
| Offline Recovery | 重连后立即调用 |
| MQTT Sync Notification | 收到后立即调用 |

通信设计的状态机总览只列出 Active/Suspended/Retired，但 Sync 和业务流程包含 Maintenance。试运营云端保留独立 Maintenance 状态；在完整行为矩阵确认前，默认沿用 Suspended 的设备处理限制，同时允许维护、同步、遥测、告警和 OTA 相关操作。

Device User Sync 示例中的 `passwordHash` 是 DEC-004@1.0.0 冻结的设备本地 Argon2id PHC 字符串：v=19、m=32768 KiB、t=3、p=1、16 字节独立随机 Salt、32 字节输出。不得下发 Cognito 密码、云端用户密码 Hash 或可用于登录云端的凭据。

## 9. 消息路由与处理

### 9.1 路由矩阵

| 消息 | 业务处理 | 原始归档 | 主要结果 |
|---|---|---|---|
| Heartbeat | 是 | 否 | 只更新每设备最新在线、固件、许可证和健康状态 |
| Telemetry | 是 | 是 | RDS 保存聚合摘要；S3 保存原始数据 |
| ESG Report | 是 | 是 | ESG 报告记录和质量指标 |
| Alarm | 是 | 是 | 告警创建、清除和通知 |
| Event | 是 | 是 | 设备操作事件 |
| ACK | 是 | 可选 | 更新 Command 状态 |
| Tamper | 是 | 是 | 安全事件、可自动挂起设备 |
| Media | 是 | 元数据 | 关联已上传的 S3 Object |

上表只包含 8 个 Device → Cloud MQTT Topic。通信设计的 Retention Policy 还列出 License 和 OTA，但 Topic Catalog 没有 License 上行 Topic，OTA 在 Catalog 中是 Cloud → Device Topic，因此二者不能作为“设备上行原始 MQTT”进入统一 Ingress。DEC-016@1.0.0 已冻结方案 A：License 历史以领域事件归档，OTA 下发/结果以发布记录及 DEC-015 ACK 结果记录归档，三类来源使用独立 Envelope 与 `raw/`、`domain/`、`operations/` 前缀。

通信设计的 Retention Policy 未列出 Media。上述 Media 策略是试运营实现决策，文件和元数据保留期必须在协议冻结阶段确认。

### 9.2 Ingestion 流程

1. IoT Rule 按 Topic 把所有上行消息写入统一 Ingress SQS；
2. Ingestion Lambda 每批读取消息；
3. 校验 Topic、证书身份、JSON、Schema 和字段范围；
4. 查询设备和 Customer 归属；
5. 按 `deviceId + type + seq` 执行幂等检查；
6. 在同一数据库事务中写入幂等凭证、业务数据和需要归档的 `outbox_event`；
7. 事务提交后删除 Ingress SQS 消息；
8. Outbox Publisher 把未发布事件发送到 Archive SQS，并记录发布时间；
9. Archive Worker 写入 S3，重复事件使用稳定归档键或 Manifest 去重；
10. 可重试错误保留在主队列，超过次数进入 DLQ；
11. 不可重试的 Schema 错误进入 Quarantine Queue，并以 `invalid` 状态保存原文。

### 9.3 幂等与乱序

- `ingestion_receipt` 保存幂等键、Payload Hash、首次接收时间和处理结果；
- 相同幂等键、相同 Hash：返回成功并跳过重复处理；
- 相同幂等键、不同 Hash：标记安全异常，不覆盖原记录；
- Telemetry 允许有限乱序，按事件时间聚合；
- 命令 ACK 和状态变更必须校验允许的前置状态；
- 检测到序号缺口时写入 `ingestion_gap`，不阻断后续数据。

### 9.4 原始归档

Archive Worker 将多条消息合并为 NDJSON/GZIP 后写入 S3。每个归档对象同时生成或记录：

- 记录数；
- 最小/最大设备时间；
- 最小/最大序号；
- 对象 SHA-256；
- Schema 版本集合；
- 写入时间和 Worker 版本。

试运营阶段原始数据建议保留至少 12 个月；正式商业合同明确后再确定是否启用 7 年 Object Lock。

## 10. 数据库设计

### 10.1 核心业务表

| 领域 | 表 |
|---|---|
| Customer 与站点 | `customers`、`sites` |
| 用户与权限 | `users`、`roles`、`user_roles`、`user_scopes` |
| 设备 | `devices`、`device_assignments`、`device_state_history` |
| 证书 | `device_certificates`、`onboarding_requests`、`onboarding_tokens` |
| 许可证 | `licenses`、`license_entitlements`、`license_history` |
| 配置 | `device_configurations`、`configuration_versions` |
| 设备用户 | `device_users`、`device_user_assignments` |
| 运行数据 | `device_latest_state`、`telemetry_hourly`、`telemetry_daily`；不建立原始 Telemetry 长期表 |
| ESG | `esg_reports`、`esg_daily_summary`、`esg_calculation_versions` |
| 告警事件 | `alarms`、`device_events`、`tamper_events` |
| 命令 | `device_commands`、`command_attempts`、`command_acks` |
| OTA | `firmware_packages`、`ota_campaigns`、`ota_targets`、`ota_status_history` |
| 媒体 | `media_objects`、`media_upload_sessions` |
| 可靠性 | `ingestion_receipts`、`ingestion_gaps`、`outbox_events`、`replay_jobs` |
| 审计 | `audit_logs` |

### 10.2 关键约束

- 所有 Customer 业务表含 `customer_id`；若底层框架沿用 `tenant_id`，数据字典必须声明其语义等同于 Customer ID；
- `devices.serial_number` 和 `devices.device_id` 唯一；
- 一个设备同一时间只允许一个有效许可证；
- 幂等键设置唯一索引；
- 命令状态只允许按状态机迁移；
- `audit_logs` 只追加，不允许业务 API 修改和删除；
- 所有时间字段以 UTC 保存；
- 软删除只用于需要恢复的业务实体，审计和状态历史不软删除。

### 10.3 数据保留

| 数据 | 试运营保留建议 |
|---|---|
| 原始 Telemetry/Report/Alarm/Event/Tamper | S3 至少 12 个月 |
| RDS Telemetry 原始明细 | 不保存；只保存通信设计要求的聚合摘要 |
| 小时/日聚合 | 长期保存 |
| 管理审计日志 | 至少 2 年 |
| ALB/API/应用日志 | 30～90 天 |
| 数据库备份 | 7～14 天，试运营结束前制作快照 |

## 11. 业务模块设计

### 11.1 客户与站点管理

功能：

- 创建、编辑、停用客户；
- 创建站点，配置地址、时区和联系人；
- 查看客户下站点和设备；
- 禁止删除仍有关联设备或有效许可证的实体。

主要 API：

```text
GET/POST       /api/v1/admin/customers
GET/PATCH      /api/v1/admin/customers/{customerId}
GET/POST       /api/v1/admin/sites
GET/PATCH      /api/v1/admin/sites/{siteId}
```

### 11.2 设备台账与生命周期

功能：

- 查看设备序列号、型号、证书、固件、站点和在线状态；
- 审批 Onboarding；
- 分配/调整客户和站点；
- 激活、挂起、恢复和退役设备；
- 查看状态历史、连接历史和最近消息。

主要 API：

```text
GET             /api/v1/admin/devices
GET             /api/v1/admin/devices/{deviceId}
POST            /api/v1/admin/devices/{deviceId}/assign
POST            /api/v1/admin/devices/{deviceId}/suspend
POST            /api/v1/admin/devices/{deviceId}/reactivate
POST            /api/v1/admin/devices/{deviceId}/retire
```

退役采用内部两阶段工作流，外部生命周期仍只使用通信设计中的状态：管理员批准退役后撤销 Entitlement/License 和 Assignment，发送 `DEVICE_RETIRED`，设备调用 Sync、进入 Retired 并通过 `/api/v1/device/deactivate` 确认；云端随后停用证书和运行能力。若设备离线无法确认，满 72 小时后自动强制停用证书并以 `UNCONFIRMED_TIMEOUT` 记录未确认退役；管理员也可在窗口内提前强制完成。这样既保留通信设计的业务步骤，也避免在通知设备前先切断其认证通道。

为避免 Retired 状态与 mTLS 白名单形成死锁，DEC-014@1.0.0 冻结如下规则：`retirement_confirmation_status=PENDING` 仅为云端内部工作流标记，不新增外部生命周期；设备证书在最长 72 小时确认窗口内保持 Active，但 Retired 设备只允许调用 `/api/v1/device/sync` 和 `/api/v1/device/deactivate`，其他 Device REST API、业务 MQTT 发布/订阅和命令均拒绝；Deactivate 成功、管理员提前强制或 72 小时超时强制后立即撤销证书。AUTH 中间件只校验证书有效性和归属，生命周期的 Endpoint Allowlist 由独立授权层执行。

### 11.3 许可证和 Entitlement

功能：

- 从设备无许可证状态 `NoLicense` 开始创建 Draft License；
- 审批并发放许可证；
- 绑定设备、有效期和功能权限；
- 续期、撤销和到期提醒；
- 触发 `LICENSE_CHANGED` Notification；
- Device Sync 返回最新许可证和 Entitlement。

状态机：

```text
NoLicense → Draft → Issued → Active → ExpiringSoon → Renewed → Active
                                  └───────────────→ Expired
Active/Expired ──────────────────→ Revoked
```

商业规则按通信设计执行：已 Onboarded 但未分配 Customer 的设备不可运行；已分配但无有效 License 的设备不可运行；只有已分配且已许可的设备才可进入 Active；License 到期后设备按策略进入受限行为，云端通过 Notification 触发立即 Sync。

### 11.4 配置与设备用户同步

功能：

- 创建配置版本；
- 按设备或型号发布；
- 保存生效时间和变更说明；
- 配置变化时发送 `CONFIG_CHANGED`；
- 设备调用 Sync 获得最新完整快照；
- 管理设备本地允许登录的用户列表。

Device Sync 使用版本号和 ETag 标识快照版本，但 V1 每次都返回完整事实快照；即使 ETag 未变化，也不得返回 `304` 或省略设备安全更新本地缓存所需的域。

Notification 类型和设备动作必须按通信设计实现：

| 类型 | 设备动作 |
|---|---|
| `SYNC_REQUIRED` | 调用 `/api/v1/device/sync` |
| `LICENSE_CHANGED` | 调用 `/api/v1/device/sync` |
| `CONFIG_CHANGED` | 调用 `/api/v1/device/sync` |
| `USERS_CHANGED` | 调用 `/api/v1/device/sync` |
| `STATUS_CHANGED` | 调用 `/api/v1/device/sync` |
| `ASSIGNMENT_CHANGED` | 调用 `/api/v1/device/sync` |
| `CERTIFICATE_EXPIRING` | 调用证书状态 API |
| `CERTIFICATE_ROTATION_REQUIRED` | 调用证书轮换 API |
| `OTA_AVAILABLE` | 等待/接收 OTA Topic |
| `OTA_CANCELLED` | 取消待执行升级 |
| `SECURITY_POLICY_UPDATED` | Sync 最新安全策略 |
| `DEVICE_SUSPENDED` | 进入 Suspended 模式 |
| `DEVICE_RETIRED` | 进入 Retired 模式 |

### 11.5 告警和事件

功能：

- 告警创建、更新、清除和确认；
- 按严重程度、设备、站点和时间筛选；
- Critical 告警触发 SNS 邮件；
- Tamper 事件可按策略自动挂起设备；
- 告警操作和状态变化完整留痕。

### 11.6 ESG 数据与报表

功能：

- 展示最近一个聚合窗口的 Telemetry 摘要；原始明细通过 S3/Athena 审计查询，不长期写入 RDS；
- 生成小时/日汇总；
- 保存设备提交的 Cycle/Hourly/Daily Report；
- 展示投料、出料、减量、能耗、气体和碳减排指标；
- 保存计算方法版本；
- 显示数据完整率和缺失记录数；
- 按 Customer、站点、设备和日期导出 CSV。

试运营阶段不把云端计算结果描述为第三方认证结论；界面应显示“计算方法版本”和“数据完整性状态”。

### 11.7 Remote Command

V1 命令白名单以通信设计为准：

| 分类 | 命令 |
|---|---|
| Machine Operation | `START`、`STOP`、`PAUSE`、`RESUME`、`EMERGENCY_STOP` |
| Motor | `AGITATOR_FORWARD`、`AGITATOR_REVERSE`、`AGITATOR_STOP` |
| Heating | `HEATING_ON`、`HEATING_OFF`、`SET_TARGET_TEMPERATURE` |
| Ventilation | `EXHAUST_ON`、`EXHAUST_OFF`、`AIR_SUPPLY_ON`、`AIR_SUPPLY_OFF` |
| Discharge | `DISCHARGE_START`、`DISCHARGE_STOP` |
| Device | `REBOOT`、`SHUTDOWN`、`FACTORY_RESET`、`TAKE_SNAPSHOT`、`FORCE_SYNC` |

新增命令必须先更新通信设计和设备能力矩阵，不能仅在管理后台增加字符串。`EMERGENCY_STOP`、`FACTORY_RESET`、`SHUTDOWN`、加热、排料和电机控制应定义为高风险命令，要求更严格的权限、确认、审计和超时策略。

Suspended 状态虽然保留 Remote Control 通道，但通信设计同时禁止 Device Processing。因此云端只允许安全停止、诊断、同步、必要维护和经批准的恢复类命令；`START`、`RESUME`、加热、搅拌和排料等会启动处理的命令必须拒绝。Retired 状态拒绝全部命令。

命令状态机：

```text
Created → Authorized → Published → Acknowledged → Succeeded
                                  ├──────────────→ Failed
                                  └──────────────→ TimedOut
Created/Authorized ───────────────→ Cancelled
```

发布前校验：

- 用户和 Customer 权限；
- 设备不是 Retired；
- 许可证有效且包含相应 Entitlement；
- 命令在设备型号白名单中；
- 设备当前状态允许执行；
- 高风险命令已二次确认；
- `expiresAt` 未过期。

### 11.8 OTA 管理

流程：

1. 管理员上传固件包；
2. 云端计算 SHA-256，验证签名并写入版本信息；
3. 创建 OTA Campaign，选择型号和目标设备；
4. 先选择 1 台设备作为灰度批次；
5. 发布 MQTT OTA 通知或创建 IoT Job；
6. 设备通过短期预签名 URL 下载；
7. 设备通过既有 ACK Topic 回传；`objectType=OTA_TARGET`、`otaTargetId` 与封闭状态集合承载下载、安装、成功、失败或回滚，普通命令 ACK 使用 `objectType=COMMAND`；
8. 管理员确认后扩大批次或暂停 Campaign。

试运营阶段禁止默认对全部设备自动强制升级。

通信设计只定义 Cloud → Device OTA Topic，并在业务场景中显示设备返回 ACK，没有定义多阶段 OTA 状态的上行 Topic 或 Payload。DEC-015@1.0.0 已冻结扩展现有 ACK 为唯一通道：不新增 `ota/status` Topic，不采用 AWS IoT Jobs 状态事件；Command 与 OTA Target 必须按判别字段和关联 ID 隔离。

### 11.9 Media 管理

Media 文件不通过 MQTT。流程为：

1. 设备通过 mTLS 请求上传会话；
2. 云端校验设备权限、类型、大小和配额；
3. 返回短期 S3 预签名上传 URL；
4. 设备上传后发布 Media 元数据；
5. 云端校验 Object 存在、大小和 Hash；
6. 管理后台使用短期下载 URL 查看。

## 12. 管理后台设计

### 12.1 角色

| 角色 | 权限范围 |
|---|---|
| PlatformSuperAdmin | 全平台配置、审批和权限管理 |
| PlatformOperator | 客户、站点、设备、许可证、OTA 和命令操作 |
| Auditor | 跨 Customer 只读、审计和报表导出 |
| CustomerAdmin | 仅管理所属 Customer 的设备用户、查看数据和有限命令 |
| CustomerViewer | 所属 Customer 只读 |

PlatformSuperAdmin、PlatformOperator 和 Auditor 强制 MFA。权限检查必须在后端执行，前端隐藏按钮不能替代授权。

### 12.2 页面清单

| 页面 | 核心内容 |
|---|---|
| 登录 | Cognito 登录、MFA、忘记密码 |
| 总览 | 在线设备、严重告警、消息成功率、今日处理量和能耗 |
| Onboarding 审批 | 待审批、设备信息、证书包状态、审批/拒绝 |
| 客户与站点 | 客户、站点、联系人和设备数量 |
| 设备列表 | 状态、在线、型号、固件、许可证、站点 |
| 设备详情 | 最新数据、Heartbeat、告警、事件、证书和状态历史 |
| 许可证 | 创建、发放、续期、撤销和 Entitlement |
| 配置管理 | 配置版本、目标设备、生效时间和同步状态 |
| 设备用户 | 用户授权和同步状态 |
| 告警中心 | 告警筛选、确认、清除和处理记录 |
| ESG 报表 | 小时/日数据、完整率、计算版本和导出 |
| Remote Command | 命令创建、二次确认、状态和 ACK |
| OTA | 包管理、Campaign、灰度批次和结果 |
| Media | 图片/视频元数据和授权查看 |
| 审计日志 | 操作人、时间、对象、前后值、IP 和结果 |
| 系统设置 | 角色、告警阈值和基础字典 |

### 12.3 关键交互要求

- 所有危险操作使用明确确认框，不使用模糊的“确定”；
- 挂起、退役、命令和 OTA 操作必须填写原因；
- 列表支持 Customer、站点、设备、状态和日期筛选；
- 时间按用户选择的时区显示，API 和数据库统一 UTC；
- 页面显示数据更新时间和数据完整性；
- 导出任务异步执行，生成短期下载链接；
- 后端错误使用稳定错误码，前端显示可操作的错误信息。

## 13. API 设计规范

### 13.1 API 分组

```text
/api/v1/device/*            设备 mTLS API
/api/v1/admin/*             平台管理 API
/api/v1/customer/*          Customer 业务 API
/api/v1/internal/*          仅限云端任务调用
```

### 13.2 通用响应

```json
{
  "data": {},
  "meta": {
    "requestId": "req-...",
    "timestamp": "2026-08-10T10:00:00Z"
  }
}
```

错误响应：

```json
{
  "error": {
    "code": "DEVICE_STATE_NOT_ALLOWED",
    "message": "The operation is not allowed in the current device state",
    "requestId": "req-..."
  }
}
```

### 13.3 API 约束

- 使用 OpenAPI 生成接口文档；
- 列表统一游标分页；
- 写操作支持 `Idempotency-Key`；
- 更新操作使用版本号或 `If-Match` 防止覆盖；
- 管理写操作记录请求人、IP、User-Agent、前值和后值；
- 日志中不得记录 Token、私钥、完整证书密钥材料和敏感个人信息。

## 14. 安全设计

### 14.1 身份认证

- 设备 MQTT：AWS IoT X.509 双向认证；
- Onboarding：一次性 Token；
- 设备 REST：API Gateway 自定义域名 mTLS；
- 人员：Cognito User Pool + JWT；
- 管理员：强制 MFA；
- CI/CD：GitHub Actions OIDC，不保存长期 AWS Access Key。

### 14.2 权限

- IoT Policy 限制到单一设备的 Topic；
- Lambda 使用独立执行角色；
- 数据库凭据存入 Secrets Manager；
- S3 阻断公网访问；
- OTA 和 Media 使用短期预签名 URL；
- 生产环境人工访问通过 IAM Identity Center 和 MFA；
- 禁止开发人员共享管理员账号。

### 14.3 数据保护

- 传输使用 TLS 1.2+；
- RDS、S3、日志和备份启用静态加密；
- S3 启用 Versioning；
- 生产日志和 CloudTrail 进入独立日志桶；
- 个人信息最小化收集；
- 导出文件设置短有效期并记录下载审计。

### 14.4 审计事件

必须审计：

- 登录、失败登录和 MFA 变化；
- Onboarding 审批和拒绝；
- 设备分配、挂起、恢复和退役；
- 许可证创建、发放、续期和撤销；
- 配置发布和设备用户变化；
- Remote Command 全生命周期；
- OTA 包上传和 Campaign 操作；
- 角色权限变化；
- 数据导出和跨 Customer 查询；
- 重放任务和人工处理 DLQ。

## 15. 可观测性与运维

### 15.1 核心指标

| 层面 | 指标 |
|---|---|
| IoT | 连接数、断连数、PublishIn、认证失败、Rule Error |
| SQS | 可见消息数、最老消息年龄、DLQ 数量 |
| Lambda | Error、Throttle、Duration、ConcurrentExecutions |
| RDS | CPU、连接数、存储、慢查询、复制/备份状态 |
| API | 4xx、5xx、P95 延迟、鉴权失败 |
| 业务 | 在线设备数、消息校验失败率、序号缺口、命令成功率、OTA 成功率 |

### 15.2 告警

- 生产设备 5 分钟无 Heartbeat；
- Critical Alarm/Tamper 事件；
- Rule Error Queue 出现消息；
- DLQ 消息数大于 0；
- SQS 最老消息超过 60 秒；
- Lambda 连续错误或被限流；
- RDS CPU 持续超过 70%、连接超过 80% 或存储低于 20%；
- 证书即将到期；
- 归档对象超过预期时间未产生；
- 每日数据完整率低于约定阈值。

### 15.3 运维 Runbook

至少提供以下操作手册：

1. 设备无法连接；
2. Onboarding 发证失败；
3. SQS 堆积；
4. DLQ/Quarantine 消息处理；
5. RDS 故障和时间点恢复；
6. 归档缺失与重放；
7. 证书吊销和紧急轮换；
8. Remote Command 异常；
9. OTA 批次暂停和回滚协调；
10. 管理员账号失陷处理。

## 16. 测试方案

### 16.1 自动化测试

| 类型 | 内容 |
|---|---|
| 单元测试 | 状态机、权限、幂等、聚合、错误码 |
| Contract Test | MQTT Schema、REST OpenAPI、前后兼容 |
| 集成测试 | IoT→SQS→Lambda→RDS/S3、Cognito、证书流程 |
| E2E | 管理员登录、Onboarding、许可证、命令、OTA、报表 |
| 安全测试 | 越权、Token 重放、Topic 越权、SQL 注入、恶意文件 |
| 恢复测试 | Lambda 失败、DLQ、RDS 恢复、归档重放 |

### 16.2 设备模拟器

云端团队需提供设备模拟器，支持：

- 10 台及更多虚拟设备；
- Heartbeat、Telemetry、Report、Alarm、Event、ACK 和 Tamper；
- 可配置 10～60 秒 Telemetry；
- 断网、恢复、批量补报、重复、乱序和坏消息；
- 模拟 Command ACK 和 OTA 状态；
- 独立设备证书和正确的 Topic 权限。

模拟器只用于云端测试，不能替代真实设备验收。

### 16.3 试运营性能场景

1. 10 台设备稳定运行 24 小时；
2. Telemetry 每 10 秒、Heartbeat 每 60 秒；
3. 10 台设备同时断线后补报 24 小时历史数据；
4. 瞬时 30 倍稳态消息速率；
5. 注入 5%重复和 2%乱序消息；
6. 暂停 Worker 30 分钟后恢复；
7. 人工注入 Schema 错误并验证隔离队列；
8. 重放指定设备、时间和序号范围的数据。

### 16.4 验收指标

| 指标 | 试运营验收值 |
|---|---|
| 合法 MQTT 消息接收 | 100%进入业务链路或可追踪重试队列 |
| 重复业务记录 | 0 |
| 未解释的序号缺口 | 0；所有缺口有记录和状态 |
| Telemetry 到管理后台 P95 | 正常负载下不超过 5 秒 |
| Command 发布 P95 | 在线设备正常情况下不超过 3 秒，不含设备执行时间 |
| 告警通知 | Critical 告警 1 分钟内产生通知 |
| DLQ | 所有消息可查看、可重试、可审计 |
| 权限隔离 | Customer 之间的越权测试全部失败 |
| 备份恢复 | staging 完成一次可复现恢复演练 |
| 连续运行 | 10 台设备连续试运行至少 7 天，无未解释数据丢失 |

## 17. CI/CD 与发布

### 17.1 流水线

```text
Pull Request
  → lint
  → typecheck
  → unit test
  → contract test
  → CDK synth
  → dependency/security scan

Merge to main
  → build artifact
  → deploy dev
  → integration test
  → manual approval
  → deploy staging
  → E2E/real-device test
  → manual approval
  → deploy prod
  → smoke test
```

### 17.2 数据库变更

- Migration 与应用版本一同管理；
- 生产部署前自动备份；
- 使用向后兼容的 Expand/Contract 方式；
- 禁止在生产环境手工修改 Schema；
- 破坏性变更必须有数据迁移和回滚方案。

### 17.3 发布策略

- Lambda 使用版本和 Alias；
- 关键 API 使用 Canary 或线性流量切换；
- 管理 Web 静态资源使用带 Hash 文件名；
- MQTT Schema 新版本至少保留一个版本的兼容窗口；
- 发布失败自动回退应用版本，数据库回滚需按 Migration 方案执行。

## 18. 项目计划

推荐 4～5 人核心团队并行开发，整体 12～16 周。

| 阶段 | 周期 | 工作内容 | 交付物 |
|---|---:|---|---|
| P0 协议与架构冻结 | 第 1～2 周 | Topic、Schema、状态机、PKI、数据模型、OpenAPI、验收基线 | 协议 V1、ERD、OpenAPI、CDK 设计 |
| P1 云基座与身份 | 第 2～4 周 | dev/staging/prod、CI/CD、Cognito、IoT、SQS、RDS、S3、日志 | 可部署基座、登录、设备证书骨架 |
| P2 Onboarding 与数据链路 | 第 4～7 周 | Token 审批、一次性证书包、IoT Policy、Ingestion、Archive、幂等、DLQ、模拟器 | 首台模拟/真实设备端到端接入 |
| P3 核心业务 | 第 6～10 周 | Customer、站点、设备、许可证、配置、用户、告警、ESG 聚合 | 核心业务 API 和数据库 |
| P4 管理后台 | 第 8～12 周 | 页面、RBAC、审计、报表和导出 | 可用管理后台 |
| P5 Command/OTA/Media | 第 10～13 周 | 命令状态机、ACK、OTA 灰度、上传流程 | 远程业务闭环 |
| P6 联调与试运营 | 第 13～16 周 | 真实设备联调、性能、安全、恢复、Runbook、上线 | 验收报告和试运营版本 |

第 2 周是协议冻结门禁：Maintenance 行为、Tier 标记、一次性证书包重复领取、Device User `passwordHash` 格式和 Media 保留期必须形成书面决定。未通过门禁时不得假定接口已稳定，整体计划需增加相应澄清时间。

### 18.1 团队配置

| 角色 | 投入 |
|---|---:|
| 技术负责人/AWS 架构师 | 1 人 |
| 后端/IoT 云端工程师 | 2 人 |
| 管理前端工程师 | 1 人 |
| 测试自动化/DevOps | 1 人，可按阶段投入 |
| 产品/业务负责人 | 0.5 人，由项目方提供 |

预计总投入约 14～20 人月。若不开发管理 Web 页面、只提供管理 API，可减少约 3～5 人月和 3～4 周日历时间。

## 19. 投入与成本建议

### 19.1 开发投入

按国内团队综合成本 4～6 万元/人月估算：

| 项目 | 估算 |
|---|---:|
| 云端后端、IoT 接入和数据处理 | 8～11 人月 |
| 管理后台 Web | 3～5 人月 |
| 测试、DevOps、安全和上线 | 3～4 人月 |
| 合计 | 14～20 人月 |
| 综合开发预算 | 约 60～120 万元 |

该预算不包括设备端开发、第三方合规认证、长期人工运维和大规模商业化改造。

### 19.2 AWS 资源成本原则

10 台设备阶段应控制固定资源：

- Lambda、SQS、IoT Core 和 API Gateway 以按量计费为主；
- 管理 Web 使用 S3 + CloudFront；
- RDS 是主要固定成本，dev/staging 可定时停机；
- 试运营生产库可先使用单 AZ，小规格起步；
- 不为 10 台设备提前部署多个常驻 Fargate Task；
- CloudWatch 日志设置保留期，避免无限增长；
- 每月设置 AWS Budget 和异常成本告警。

正式 AWS 月度预算应在协议冻结后，根据真实 Payload 大小、上报频率、日志量和 RDS 规格通过 AWS Pricing Calculator 复核。

## 20. 项目依赖和风险

| 依赖/风险 | 应对措施 |
|---|---|
| 设备无法安全领取或安装一次性证书包 | 第 2 周用真实设备验证；失败时按通信设计处理负向案例并重新签发 |
| Payload 字段持续变化且源稿存在扁平/嵌套等冲突 | 先完成 DEC-013 和设备/云端联合 Fixture，再冻结 Schema V1；变更必须版本化 |
| Retired 后认证过早关闭 | 通过 DEC-014 固定仅 Sync/Deactivate 可用的过渡期 Allowlist，并用集成测试证明不会形成认证死锁 |
| OTA 多阶段状态没有上行契约 | DEC-015@1.0.0 已冻结既有 ACK 扩展为唯一通道，并以判别字段隔离 Command/OTA Target |
| License/OTA 归档来源不明确 | 通过 DEC-016 区分 MQTT 原文、领域事件和发布记录，禁止伪装成设备上行消息 |
| Onboarding 首个 Heartbeat 永久未到达 | DEC-017@1.0.0：证书包存储后 24 小时硬截止，超时撤证销包、外部 REJECTED/ONBOARDING_TIMEOUT，新 Token 重新申请 |
| Configuration 候选字段超出源稿 | 通过 DEC-018 与设备能力协商冻结；未批准字段不得进入 Sync |
| 真实设备到位延迟 | 使用模拟器开发，但预留至少 3 周真实联调窗口 |
| ESG 计算口径不明确 | 保存原始数据和计算版本，试运营先标识“非核证” |
| 远程命令安全责任不清 | 建立命令白名单、权限矩阵和设备安全确认协议 |
| OTA 包签名机制未确定 | OTA 上线前冻结签名格式和信任根 |
| 试运营后设备快速增长 | 监控 SQS、Lambda、RDS 和 S3 指标，按触发条件扩容 |
| 管理后台需求蔓延 | 以页面清单和验收场景作为 V1 范围基线 |

## 21. 上线检查清单

### 协议与设备

- [ ] DEC-013～018 已登记、完成双方确认并解除对应任务阻塞；
- [ ] Topic、QoS、Schema 和错误码已冻结；
- [ ] 10 台设备各自使用独立证书；
- [ ] 设备不能发布或订阅其他设备 Topic；
- [ ] Onboarding、轮换、吊销流程已演练；
- [ ] 设备团队确认本地持久队列和命令安全规则。

### 云端

- [ ] dev、staging、prod 完全隔离；
- [ ] CDK 可以从空环境重复部署；
- [ ] RDS 自动备份和恢复演练通过；
- [ ] SQS DLQ、Quarantine 和 Rule Error 告警可用；
- [ ] S3 阻断公网访问并启用 Versioning；
- [ ] Secrets Manager 中无明文凭据泄漏；
- [ ] AWS Budget 和成本异常告警已配置。

### 业务与后台

- [ ] 角色权限和 Customer 隔离测试通过；
- [ ] 所有危险操作有确认、原因和审计；
- [ ] 命令、ACK、超时和重复处理测试通过；
- [ ] OTA 单台灰度、暂停和失败流程通过；
- [ ] ESG 报表显示计算版本和完整率；
- [ ] 数据导出有权限、有效期和下载审计。

### 运维与验收

- [ ] 10 台设备连续运行至少 7 天；
- [ ] 30 倍突发、重复、乱序和断网补报通过；
- [ ] DLQ 和归档重放演练通过；
- SES/Webhook 业务通知延期，不作为当前验收项；
- [ ] Runbook、联系人和升级机制已移交；
- [ ] 已形成试运营验收报告和已知问题清单。

## 22. 最终交付物

1. 云端和管理后台源代码；
2. AWS CDK 基础设施代码；
3. MQTT Topic、JSON Schema 和设备接入协议 V1；
4. REST OpenAPI 文档；
5. 数据库 ERD、Schema 和 Migration；
6. 设备模拟器；
7. 管理后台 Web；
8. 自动化测试和测试报告；
9. 性能、安全和恢复演练报告；
10. 部署、监控、告警和故障处理 Runbook；
11. 试运营上线清单和验收报告。

## 23. 结论

在最多 10 台设备、仅开发 AWS 云端业务和管理后台的边界下，项目可在 4～5 人核心团队、12～16 周、约 14～20 人月内完成可试运营版本。方案采用轻量 Serverless 架构降低早期固定成本，同时通过稳定的设备协议、证书体系、幂等机制、数据分层和 CDK 保留后续规模化能力。项目成功的首要条件不是提前扩容，而是在前两周冻结设备云端协议，并确保真实设备团队能够按该协议持续配合联调。

## 24. 参考资料

- [Device-Cloud Communication Design](./Device-Cloud%20Communication%20Design.pdf)
- [Device-Cloud Communication Design 解析与信息汇编](./Device-Cloud-Communication-Design-解析.md)
- [厨余设备 ESG 物联网平台 AWS 架构设计与技术方案](./厨余设备ESG物联网平台AWS架构设计与技术方案.docx)
- [AWS IoT Core MQTT 与 QoS](https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html)
- [AWS IoT CreateKeysAndCertificate](https://docs.aws.amazon.com/iot/latest/apireference/API_CreateKeysAndCertificate.html)
- [API Gateway Mutual TLS](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-mutual-tls.html)
- [AWS IoT Core 安全最佳实践](https://docs.aws.amazon.com/iot/latest/developerguide/security-best-practices.html)
- [Amazon Data Firehose 数据交付](https://docs.aws.amazon.com/firehose/latest/dev/basic-deliver.html)
