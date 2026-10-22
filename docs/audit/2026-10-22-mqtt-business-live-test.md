# MQTT 八类上行与三类下行业务实测报告

日期：2026-10-22，北京时间。目标：`iot.bio-nexa.com:8883`，AWS 账号 `065986019555`，新加坡区域 `ap-southeast-1`。

**结论：在共享 test 环境内，使用独立软件测试设备和独立业务数据，8 类上行、3 类下行的本次业务收发验证通过。** 最终第 4 轮共发布 **12 条** QoS 1 上行，数据库产生 **12 条 PROCESSED 回执**；实际接收 **4 条下行**，覆盖 cmd、ota、notification 三类；**11 个归档原文和 11 个 manifest** 全部匹配。16 项检查通过，活动测试资源已清理并回查。

本结论限定于软件客户端与云端业务处理。设备方真实固件、项目 CA / Onboarding / REST 证书流程、实际命令动作、OTA 下载/签名核验/实体安装、性能及生产验收均不在本次通过范围。审计记录、CloudWatch 执行日志和关联的软删除客户记录按审计约束保留。

本次是正向收发验证，没有逐一发送完整样例目录中的全部 55 份报文，也未执行跨设备拒绝、QoS 重复、并发或掉线恢复用例。

## 1. 环境与证据基线

| 项目 | 最终实测值 |
|---|---|
| 轮次 | attempt-4，原始回执 gate=PASS、cleanupGate=PASS |
| 时间 | 2026-10-22 18:52:37—2026-10-22 18:58:28 |
| 隔离 Client ID / Thing | `mqttbiz-2e47988c5fcee922` |
| Customer / Site | `eb1e4a0e-e810-4375-81b5-1b3cb7cc578d` / `e82811bd-a77c-4d73-8a6f-42150dc35036` |
| 连接主机 / SNI | `iot.bio-nexa.com` |
| 连接方式 | MQTT 3.1.1，TLS 8883，X.509，clean session，禁止自动重连 |
| 仓库基线 | `be2d03394f9c396e97b858470fb5ecd01b10ca19` |
| 执行源码 | [sources.json](./evidence/mqtt-business-2026-10-22/sources.json) 记录 Hash，并与最终运行回执 sourceHashes 核对 |
| 部署处理器 | [最终回执 workers](./evidence/mqtt-business-2026-10-22/attempt-4/result.json) 记录 ingestion、command-publisher、ota-dispatcher、notification-publisher、outbox-publisher、archive 的 CodeSha256 / LastModified |

这是共享测试环境中的独立数据与身份，不是独立 AWS 环境。没有修改现有设备、服务代码、IAM/KMS 策略或 EventBridge 调度；现有每分钟发布器处理本次独立任务。回执记录部署制品指纹，但未据此宣称部署与仓库 HEAD 同 SHA，也不升级为完整 QA-09 或 productionAccepted。

## 2. 测试准备与实际链路

- 为本轮创建独立 Thing、AWS 签发测试 X.509 证书及逐设备策略；私钥仅存于进程内存，未写入仓库或回执。
- 专用临时 VPC Lambda 通过固定 SQL 创建独立 Customer、Site、设备、分配历史、证书台账及 Active License / Entitlement 测试数据。Fixture 的创建不是对管理 REST API 或正式 License 签发的验收。
- 通过现有应用服务角色的临时、路径与 Hash 受限执行器，上传测试 PNG 和非可执行 OTA 测试文件，沿用桶的 KMS 加密；没有扩大运维身份权限。
- 先在单一 MQTT 连接订阅自身 cmd / ota / notification，确认 QoS 1 SUBACK，再发布上行并等待 RDS 处理。
- 为已部署发布器准备独立 AUTHORIZED 命令、RUNNING OTA Campaign / PENDING Target 及 SYNC_REQUIRED Outbox。没有直接从测试工具向下行 Topic 伪造发布消息。
- 软件客户端收到真实下行后，上报命令成功 ACK 和 OTA 的 DOWNLOADING、INSTALLING、SUCCEEDED；每阶段等到数据库确认再继续。
- 核对 IoT Rule → SQS → Ingestion Worker → RDS；再核对 Outbox → SQS → Archive Worker → S3 原文与 manifest。PUBACK、业务处理、下行接收和归档分别核对。

测试文件与 VERIFIED 包记录是专门预置的 fixture；OTA 内容并非可安装固件，命令 ACK 不证明真实 FORCE_SYNC 的 REST 调用完成。

## 3. 八类上行核对矩阵

Topic 前缀均为 `bnx/device/mqttbiz-2e47988c5fcee922/`；QoS 1、Retain false。下表数量均来自最终第 4 轮。

| 类型 | 上行数 | Broker / 数据库 | 业务结果 |
|---|---|---|---|
| heartbeat | 1 | PUBACK；PROCESSED | device_latest_state ONLINE、IDLE，记录本轮心跳时间 |
| telemetry | 1 | PUBACK；PROCESSED | telemetry_hourly sample_count=1；13 项指标的 avg/min/max/count 与报文逐项匹配 |
| report | 1 | PUBACK；PROCESSED | esg_reports 保存 CYCLE、期间和 feeding_weight_kg=250，source_message_id 对应本轮报告 |
| alarm | 2 | 两次 PUBACK；两条 PROCESSED | 同 code 的 ACTIVE → CLEARED，保留一条已解除告警 |
| event | 1 | PUBACK；PROCESSED | device_events 保存 MQTT_BUSINESS_PROBE，source_message_id 对应上行 |
| ack | 4 | 四次 PUBACK；四条 PROCESSED | 一条命令 ACK 使命令 SUCCEEDED；三条 OTA ACK 使 Target 按状态机到 SUCCEEDED |
| tamper | 1 | PUBACK；PROCESSED | tamper_events 保存 WARNING 测试事件；不测试 CRITICAL 自动挂起 |
| media | 1 | PUBACK；PROCESSED | 对象存在、大小及真实 SHA-256 校验通过，media_objects AVAILABLE、会话 COMPLETED |

全部 12 条回执的 device_id、customer_id、site_id、topic_type、seq 与测试台账及报文关联。payload_hash 与原始报文的规范化 Hash 一致。Telemetry、Report、Tamper 的 audit.hash 单独按 RFC 8785 校验。

## 4. 三类下行与业务回执

| 类型 | 实际接收 | 云端与客户端对应关系 |
|---|---|---|
| cmd | 1 条 FORCE_SYNC | `meta.id=CMD-MQTTBIZ-2E47988C5FCEE922-1`；生产发布记录 PUBLISHED，客户端回传同一 ID / command 后，command_acks=SUCCESS、device_commands=SUCCEEDED |
| ota | 1 条 FIRMWARE 任务 | 原始 Target ID `a7afa531-740d-4e8d-b33e-f01918a1a6d1` 与下载 URL 路径一致，包摘要与测试文件一致；ota_status_history 依次 NOTIFIED → DOWNLOADING → INSTALLING → SUCCEEDED |
| notification | 2 条 | SYNC_REQUIRED 与 OTA_AVAILABLE；通知 meta.id 由对应 Outbox ID 派生，Outbox 状态 PUBLISHED |

客户端实际收到的每条下行均通过当前 Schema；不能仅凭 SUBACK 判断消息已投递。下载授权 token 在共享回执中替换为 REDACTED，原始消息只保留 SHA-256，未公开有效 token 或预签名 URL。

## 5. S3 归档核对

最终检出 **11 个 gzip 原文 + 11 个 manifest**，覆盖全部 11 个 ARCHIVE Outbox eventId：

- 7 条 MQTT RAW：Telemetry 1、Report 1、Alarm 2、Event 1、Tamper 1、命令 ACK 1。
- 4 条 OTA OPERATION_RECORD：PUBLICATION 1、RESULT 3。
- Heartbeat 和 Media 按当前处理器不产生这些 RAW 归档，不把缺少 RAW 对象视为消息丢失。

对每个 gzip 验证压缩字节 SHA-256、NDJSON 记录数、deviceId / customerId、eventId 关联；对 RAW 去除五个 IoT Rule 上下文字段后，与发送报文规范化内容比对。每个 manifest 的 key、recordCount 和 sha256 均匹配对应对象。

证据保存在 [attempt-4](./evidence/mqtt-business-2026-10-22/attempt-4/)，包括原始 read-archives 回应、11 个 gzip 及单独提取的 manifest。云端归档版本在证据保存后删除。

## 6. 清理与保留项

最终轮的数据库清理回执记录删除了 53 行活动测试数据，涵盖设备、分配历史、证书台账、License / Entitlement、命令、OTA、媒体会话、业务结果、Outbox 和回执。随后只读核对活动表为空。

- 删除测试 PNG 与 OTA 文件的指定版本；删除本客户专属前缀下的 **22 个**归档及 manifest 版本，回查前缀无版本残留。
- 解绑并删除 IoT Policy、证书和 Thing；删除数据库执行器及两个上传执行器。
- [跨轮清理回查](./evidence/mqtt-business-2026-10-22/cleanup-readback.json) 对四轮的 Thing、证书、Policy、临时 Lambda 和上传对象返回 NOT_FOUND / 空版本列表，allRuntimeResourcesAbsent=true。
- 保留追加式 audit_logs 及其引用的客户记录。客户已置为 SUSPENDED 且 deleted_at 非空；这是保留审计关联所需的关闭记录，不是仍可使用的测试客户。
- CloudWatch 执行日志按现有 DenySecurityAuditTampering 策略保留，没有为了清理而修改审计或权限策略。

## 7. 历史失败与恢复

以下原始回执均保留，不将失败改写为通过；当前结论以第 4 轮完整通过为准。

| 轮次 | 原始结论 | 原因与处理 |
|---|---|---|
| [attempt-1](./evidence/mqtt-business-2026-10-22/attempt-1/result.json) | FAIL；原 cleanupGate=FAIL | 运维角色缺少项目 KMS GenerateDataKey 资源授权，尚未发布业务消息；日志删除被审计策略拒绝。活动资源已删除并回查，后续通过既有应用角色上传，日志保留 |
| [attempt-2](./evidence/mqtt-business-2026-10-22/attempt-2/result.json) | FAIL；原 cleanupGate=FAIL | 告警对象被调用方后续修改，本地记录失真导致逐报文核对超时；记录器改为深拷贝并增加回归测试。硬删除客户被 audit_logs 外键阻止，专用 [cleanup recovery](./evidence/mqtt-business-2026-10-22/attempt-2/recovery/result.json) 按审计保留策略完成活动数据清理 |
| [attempt-3](./evidence/mqtt-business-2026-10-22/attempt-3/result.json) | FAIL；cleanupGate=PASS | 8+3 业务结果已出现，但读取器将 manifest JSON 当 gzip 解压，归档校验失败。增加格式区分、全量 Outbox 完成等待与 manifest 摘要核对 |
| [attempt-4](./evidence/mqtt-business-2026-10-22/attempt-4/result.json) | PASS；cleanupGate=PASS | 8 类上行、3 类下行、12 条回执、11 个原文 / manifest 及活动资源清理全部通过 |

上述修改仅涉及测试工具和证据采集，不是修复或重新部署云端生产处理器。

## 8. 检查与复跑

- 本地检查：7 项测试工具回归 + 72 项 MQTT 契约测试，合计 **79/79**；三个新增脚本的 ESLint / Prettier 检查通过。
- [证据校验结果](./evidence/mqtt-business-2026-10-22/verification.json) 核对逐报文 Hash、客户/站点归属、13 项遥测聚合、任务状态、S3 原文 / manifest、源码 Hash、失败历史和清理结果。
- [SHA-256 清单](./evidence/mqtt-business-2026-10-22/manifest.json) 固定共享证据文件字节；[源码指纹](./evidence/mqtt-business-2026-10-22/sources.json) 对应实际执行脚本。

只做离线证据检查：

```bash
node --import tsx docs/audit/evidence/mqtt-business-2026-10-22/verify.mjs
```

再次执行真实 AWS 测试需要有效的 esgiot-infra / esgiot-readonly 会话、现有 test 资源与应用角色，以及全新输出路径：

```bash
FDP_MQTT_BUSINESS_TEST=1 node --import tsx scripts/run-mqtt-business-smoke.mjs \
  build/mqtt-business-new-run/result.json
```

脚本会创建有范围约束的 fixture 并在 finally 清理，保留审计日志及软删除客户记录；不要对旧回执目录重跑。设备方下一步仍需使用真实 Onboarding 证书及固件完成业务动作、下载安装、REST Sync 和长期稳定性联调。
