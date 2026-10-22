# 真实 CSR、首次 Heartbeat 激活与双通道证书轮换实测

日期：2026-10-22，北京时间。目标：AWS `065986019555 / ap-southeast-1` 的共享 `fdp-test-app` 环境；MQTT 使用 `iot.bio-nexa.com:8883`，REST 使用 `device-api.bio-nexa.com`。

**结论：一台隔离软件设备的真实 CSR 申请、管理员审批、项目 CA 签发、首次 Heartbeat 激活、REST Sync，以及两种顺序的双通道证书轮换均通过。** 共 52 项实测检查通过；三条 Heartbeat 均产生 `PROCESSED` 回执。两次轮换分别证明单通道不撤旧证、双通道完成后撤销旧证、Sweeper 停用旧 IoT 证书、旧证 REST / MQTT 被拒绝及新证仍可用。活动测试资源已清理，另有七项独立云端不存在回查通过。

这是软件客户端与真实云端的限定验收。没有使用实体设备或真实固件；不包含业务分配、License 激活、全部 REST 操作、24 小时超时回退、性能或生产验收，也不升级为完整 QA-09。审计日志按要求保留。

## 1. 运行与证据基线

| 项目 | 实测值 |
|---|---|
| 轮次 / Gate | attempt-1；PASS；无失败的云端测试轮次 |
| 时间 | 2026-10-22 19:16:16—19:23:54，含清理 |
| 出厂序列号 | `csrprobe-8c4d3f19662ff1c3` |
| 申请 ID | `8549d105-f537-42eb-8b4c-653262e1d302` |
| 审批创建的 Device ID / Thing / MQTT Client ID | `4fe6ba4a-db4c-44a8-92f4-0b8a19532702` |
| 项目签发 CA | `C=SG / O=Food Digester Platform / OU=Test PKI / CN=FDP Test Issuing CA 2026` |
| 源码基线 | `790d5b3c`；执行器当时尚未提交，按 sourceHashes 和保存的源码字节绑定 |
| MQTT | 3.1.1，TLS 8883，验证主机名及服务端证书，Client ID 使用审批返回的 Device ID |
| 设备 / 业务归属 | 审批自动创建；无 Customer、Site、Assignment 或 License |
| 原始回执 | [receipt.json](./evidence/csr-lifecycle-2026-10-22/attempt-1/receipt.json) |
| 源码 / 清单 / 复核 | [sources.json](./evidence/csr-lifecycle-2026-10-22/sources.json)、[manifest.json](./evidence/csr-lifecycle-2026-10-22/manifest.json)、[verification.json](./evidence/csr-lifecycle-2026-10-22/verification.json) |

六个实际部署函数的 CodeSha256、LastModified、State 在运行前后相同，见回执 `workersBefore / workersAfter`。记录制品指纹不表示部署与仓库 HEAD 同 SHA。没有部署应用改动、修改 IAM/KMS、CA、Truststore、域名或调度，也没有手工触发处理共享设备的 Sweeper。

## 2. 真实申请、审批与签发

1. 创建独立 Cognito 管理员测试用户，禁止发送邀请邮件；使用真实 SRP 首次登录和改密。没有使用已有人的登录会话。
2. 软件设备本地生成 RSA 2048 私钥及有效的 PKCS#10 CSR，向 `onboard-api.bio-nexa.com/api/v1/device/onboarding/request` 提交真实申请，返回 **201**。
3. 使用本地私钥签名查询申请，返回 **200 / PENDING**；重放同一 nonce 返回 **401**。
4. 使用管理 REST 接口读取申请版本，再以 `If-Match` 审批，返回 **200**。审批事务实际创建设备台账、`OnboardingApproved` 状态及签发任务。本轮没有数据库 seed，没有手工创建 Thing、注册证书或修改接入状态。
5. 等待现有 `fdp-test-onboarding-provisioning` 每分钟任务。真实 Job 在一次尝试后 `COMPLETED`，签名轮询返回 **APPROVED** 和公钥证书包。
6. 核对 CSR 公钥、设备本地私钥与叶证书匹配；校验 CA 逐级签名、有效期、CN=`deviceId`、URI SAN=`urn:fdp:device:<deviceId>`、`digitalSignature` 和 `clientAuth`。三张证书均由同一项目 CA 链签发，没有云端返回的设备私钥。
7. AWS 回查证实 Thing 已创建，初始证书为 `ACTIVE`，证书绑定该 Thing，逐设备策略已附加。策略限定自身 Client ID、八个上行及三个下行资源，无资源通配符；正文见 [device-policy.json](./evidence/csr-lifecycle-2026-10-22/attempt-1/device-policy.json)。本轮只实际发送 Heartbeat，其他 Topic 的收发证据仍见 [此前业务实测](./2026-10-22-mqtt-business-live-test.md)。

私钥、管理员密码、Cognito Token 和 AWS 临时凭据只在进程内存中使用，未保存到日志、证据或仓库。证据中的 CSR、叶证书和 CA 链均为公钥材料。Onboarding 仍返回默认 AWS Data-ATS Host；本轮按运维环境参数连接自定义 Host，没有修改返回端点。

## 3. 首次 Heartbeat 与 REST Sync

| 阶段 | 云端实测结果 |
|---|---|
| 发证领取后、首次 Heartbeat 前 | Device=`OnboardingApproved`；DB 证书=`PENDING_CLAIM`；MQTT / REST 验证时间均为空 |
| 19:18:32 首条 Heartbeat 发布 | 自定义域名 MQTT CONNECT 成功，QoS 1 PUBACK；数据库 seq=1、`PROCESSED`，原始报文规范化 Hash 与回执一致 |
| 首 Heartbeat 处理后、REST 前 | Device=`Onboarded`；DB 证书=`ACTIVE`；`mqttVerifiedAt=19:18:40.486`；`restVerifiedAt=null`；待领包已销毁；仅一条进入 Onboarded 的状态历史 |
| 19:18:53 REST 验证 | 同一叶证书及客户端链通过 mTLS；`POST /api/v1/device/sync` 返回 200 和网关 requestId，记录 `restVerifiedAt` |
| Sync 快照 | `deviceId` / 序列号准确；`assignment=null`、`license=null`、`configuration=null`、`deviceUsers=[]`，生命周期 `Onboarded`，返回 snapshotAt / etag |

这证明首次接入由有效 Heartbeat 激活，无须等待 REST。`Onboarded` 表示完成接入，不代表设备进入业务生命周期 `Active` 或获得 License。测试 Heartbeat 使用 Schema fixture 的运行状态字段；Sync 中的运行状态也不能替代服务器的业务许可与生命周期判定。

## 4. 两种顺序的轮换闭环

每次均由设备本地生成全新密钥/CSR，再用当前有效旧证调用真实 `POST /api/v1/device/certificate/rotate`，返回 **200** 和新的公钥证书/CA 链。三组公钥指纹互不相同；新证 CN/SAN、用途及签名链逐一校验。

| 轮次 | 第一通道及单通道边界 | 第二通道及确认 | 旧证结果 |
|---|---|---|---|
| MQTT → REST | 新证 Heartbeat seq=2，19:19:03.024 记录 MQTT 验证；REST 验证与确认时间仍为空。旧证 DB / AWS 均 ACTIVE，旧证 Sync=200 | 新证 Sync=200；19:19:07.965 记录 REST 验证及 `rotationConfirmedAt`，新证 ACTIVE、包销毁，旧证 DB REVOKED / 撤销时间落库 | 旧证 Sync=401；随后 AWS INACTIVE；旧证 MQTT 无 CONNACK，新证相邻对照 CONNECT 成功 |
| REST → MQTT | 新证 Sync=200，19:19:14.379 记录 REST 验证；MQTT 验证与确认时间仍为空。旧证 DB / AWS 均 ACTIVE，旧证 Sync=200 | 新证 Heartbeat seq=3；19:19:23.569 记录 MQTT 验证及 `rotationConfirmedAt`，新证 ACTIVE、包销毁，旧证 DB REVOKED / 撤销时间落库 | 旧证 Sync=401；随后 AWS INACTIVE；旧证 MQTT 无 CONNACK，新证相邻对照 CONNECT 成功 |

两次确认均在 `rotationDeadlineAt` 前，`rotatedFromId` 正确关联旧证。两张旧证的 `iotDeactivationPending` 先落库为 true，再由既有 `fdp-test-cert-package-sweeper` 五分钟任务于 **19:22:13.499** 完成停用并置 false，`iotDeactivatedAt` 落库。没有由测试清理动作代替这一停用步骤；清理在负向连接及对照测试之后才开始。

MQTT 负向观察均为 `CLOSED_BEFORE_CONNACK`，并非收到明确的 Broker “Not authorized” 返回码。结合此前 AWS `INACTIVE` 读回及紧邻的新证成功连接，限定判定为旧证无法建立 MQTT 会话；没有把任意网络超时当成拒绝证据。最终最新证书 REST Sync 再次为 200。

本轮直接调用设备 Rotate 接口，**未测试管理员发起轮换通知及 notification 消费链**。24 小时窗口未通过修改时钟或数据库来加速；超时回退不在本次通过范围。

## 5. 数据库与清理核对

临时 VPC Lambda 仅执行固定、精确序列号限定的只读观察与最终清理，通过既有应用角色在 AWS 内访问数据库凭据；没有把数据库 Secret 下载到本地，也没有数据库 schema / migration 变更。

- 14 份主流程 DB 回执以及一份签发诊断回执保留在证据目录，包含申请、Job、生命周期历史、证书状态、验证时间、公开密钥归属、业务回执和审计索引；不导出证书包密文或私钥。
- 三条 Heartbeat 的 seq=1/2/3、`PROCESSED` 和 payload_hash 分别关联实际发布报文，不能仅凭 PUBACK 判定成功。
- 原有 **3 台设备、4 张证书** 的行数与内容指纹在观察和清理前后相同。这一比较只覆盖设备和证书表，不宣称对整个共享数据库做了快照验收。
- 清理前确认本次签发 Job 已完成，无处理中 Job 或未发布 Outbox。保留 **18 条**云端审计记录及 CloudWatch 日志；本轮未创建客户，无需保留客户墓碑。

| 已清理资源 | 数量 / 独立回查 |
|---|---|
| AWS IoT 证书 | 3；逐一 DescribeCertificate → ResourceNotFoundException |
| Thing / 逐设备策略 | 各 1；DescribeThing / GetPolicy → ResourceNotFoundException |
| 设备、证书、公钥归属 | DB 删除 1 / 3 / 3；事务完成，后续 own scope 为空 |
| 首次接入记录 | 申请 1、签发 Job 1、nonce 7；均清理 |
| 心跳 / 状态记录 | ingestion_receipts 3、device_latest_state 1、device_state_history 2；均清理 |
| 临时管理员 | 全局登出并删除；AdminGetUser → UserNotFoundException；没有残留应用用户行 |
| 临时观察 Lambda | 1；GetFunctionConfiguration → ResourceNotFoundException |

清理结果见回执 `cleanup / cleanupState` 及独立 [cleanup-readback.json](./evidence/csr-lifecycle-2026-10-22/cleanup-readback.json)。没有创建业务归档、媒体、固件包或 S3 测试对象。

## 6. 检查与复核

- 本地 **78/78**：六个隔离/清理保护与双通道证据测试，以及 72 个 MQTT 契约测试，见 [local-tests.log](./evidence/csr-lifecycle-2026-10-22/local-tests.log)。
- 新增脚本 ESLint、Prettier；变更文件空白、Markdown 本地链接和敏感信息扫描通过，见 [validation.json](./evidence/csr-lifecycle-2026-10-22/validation.json)。
- [离线复核器](./evidence/csr-lifecycle-2026-10-22/verify.mjs) 验证执行源码字节、证据清单、CSR/证书链、双通道前后状态、Heartbeat Hash、原有设备/证书指纹及清理结果，不连接 AWS。
- 准备阶段的错误资源名、Node TS loader 和旧 CLI 入口导入问题均见 [preparation-notes.json](./evidence/csr-lifecycle-2026-10-22/preparation-notes.json)，发生在真实资源创建前；最终使用 `node --import tsx`，没有丢弃失败的云端轮次或伪造旧 QA-09 版本 Gate。

```bash
node --import tsx docs/audit/evidence/csr-lifecycle-2026-10-22/verify.mjs
node --import tsx --test scripts/csr-lifecycle-smoke.test.mjs contracts/mqtt/*.test.ts contracts/mqtt/*.test.mjs
```

需重新实测时，使用新的输出目录和有效测试环境 SSO 权限，执行器会创建新序列号和真实测试资源并在结束时清理：

```bash
FDP_CSR_LIFECYCLE_TEST=1 node --import tsx scripts/run-csr-lifecycle-smoke.mjs \
  /tmp/fdp-csr-new-attempt/receipt.json
```

公钥 CSR / 叶证书 PEM 保留签发器的原始 CRLF 字节；仅该证据目录的 PEM 设置 `-text` 和 `cr-at-eol`，防止 Git 转换原文且允许原始行尾。manifest 不包含自身和派生的 verification.json；所有原始回执和源码证据均纳入 SHA-256。当前接口文档已同步限定实测范围，历史报告仍保留各自当时的 NOT RUN 边界。

## 7. 尚未执行

真实硬件密钥生成/安全存储、固件掉线重试与持久序号、带 Customer/Site/License/Configuration/Device Users 的完整 Sync、管理员轮换通知、24 小时超时回退、首次领取丢包恢复、全量异常/跨设备矩阵、其他 REST 操作、命令实体动作、OTA 安装、容量及生产验收均为 **NOT RUN**。此前 [八类上行与三类下行业务测试](./2026-10-22-mqtt-business-live-test.md) 的 fixture 与软件 ACK 边界不因本次通过而消失。
