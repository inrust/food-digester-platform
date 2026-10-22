# 带 Customer/Site、License、配置和设备用户的 REST Sync 实测

日期：2026-10-22，北京时间。目标：AWS `065986019555 / ap-southeast-1` 共享 test 环境，`device-api.bio-nexa.com/api/v1/device/sync`。

**结论：六域业务内容与云端状态核对通过；完整 REST 响应契约验收为 FAIL，尚不能判定完整接口验收通过。** 最终第 3 轮完成九次完整快照比较、配置/用户版本变化及确认记录核对；151 项检查中 139 项通过、12 项响应 Schema 检查失败，均为服务实际返回 `operationalStatus.operationalStatus="ACTIVE"`，不符合 REST 契约枚举。未改写响应、放宽契约或部署修复。

最终轮及第 2 轮遗留资源均已清理，另有 14 项独立云端回查通过。保留失败轮次、恢复清理、原始回执、源码字节、审计日志和软删除客户/站点记录。私钥、密码、完整设备用户 PHC 验证值和 Token 未写入证据。

## 1. Gate 与运行基线

| 层次 | 结果 / 边界 |
|---|---|
| 六域内容及云端状态 | PASS：九次完整快照比较；12 次成功 Sync 响应，包括首次空快照及 License 接收控制 |
| REST 响应契约 | **FAIL_CONTRACT**：12 次 200 响应均返回非法 REST 运行状态枚举 `ACTIVE` |
| 清理 | PASS：最终轮四项清理阶段、第 2 轮独立恢复清理、14 项云端回查 |
| 本地检查 | 36/36 测试通过；脚本 lint / format、敏感信息、链接、字节与清单检查见验证附件 |
| License 设备独立 HMAC 验签 / VERIFIED | NOT RUN：没有提取签名密钥，没有声明 VERIFIED，没有进入设备生命周期 Active |
| 设备用户本地应用 | NOT REPORTED：云端 ACKNOWLEDGED 只证明后续 Sync 确认了此前快照版本 |
| 实体固件 / 全量异常矩阵 / 性能 / 生产 | NOT RUN；本轮不升级为完整 QA-09 或生产验收 |

| 项目 | 最终第 3 轮实测值 |
|---|---|
| 时间（含清理） | 2026-10-22 19:59:24—20:06:46 |
| 序列号 / 独立型号 | `syncprobe-d0b440b808945055` / `SYNC-D0B440B808945055` |
| Device ID / IoT Thing / Client ID | `0ea0b744-5486-4329-b545-7c8ec82333c4` |
| 主 Customer / Site | `de729c94-3eb1-4e4d-b094-a819450143e6` / `a12d393b-d7dc-49ef-891b-d869a73f215f` |
| License | `e1041752-f7cc-4809-bf9a-065309471f52`；Active；version=3；2026-10-21 至 2026-11-21 展示日期 |
| 有效设备用户 | `5b677027-3a1b-4c9e-9db2-6db300d2d50a`；用户版本 2 → 3 |
| 源码基线 | `2ff6840191c452558464f73f88d990c596ccd0b7`；新执行器按源码 Hash 和冻结字节绑定 |
| 原始回执 | [attempt-3/receipt.json](./evidence/rest-sync-2026-10-22/attempt-3/receipt.json) |
| 完整快照（已脱敏） | [final-snapshot.redacted.json](./evidence/rest-sync-2026-10-22/final-snapshot.redacted.json) |
| 字节绑定 / 复核 | [sources.json](./evidence/rest-sync-2026-10-22/attempt-3/sources.json)、[manifest.json](./evidence/rest-sync-2026-10-22/manifest.json)、[verification.json](./evidence/rest-sync-2026-10-22/verification.json) |

这是共享环境中的独立身份与数据，不是独立 AWS 环境。型号使用本轮专属值，型号配置只命中本设备；没有给已有型号或其他设备发布配置。八个部署函数的 CodeSha256 / LastModified 在运行前后不变；这不等于已证明部署与仓库 HEAD 同 SHA。

## 2. 真实准备流程

- 创建独立 Cognito PlatformSuperAdmin，SUPPRESS 邀请邮件，使用真实 SRP 登录。没有使用已有人的会话。
- 设备本地生成私钥/CSR，经真实申请、审批、项目 CA 签发及签名领取取得证书；首次 MQTT Heartbeat 激活为 Onboarded，再用同一叶证书和 CA 链调用 mTLS Sync。没有预置设备、证书或改写业务生命周期。
- 通过管理 API 创建两个独立 Customer / Site。主设备实际分配至主 Customer / Site；跨客户 Site 分配返回 400。
- 通过真实管理 API 创建 Draft License，签发为 Issued，再激活 License 为 Active。三项 Entitlement 为 REMOTE_CONTROL、OTA、ESG_REPORTING。此步骤不等于设备独立验签或设备进入 Active。
- 创建型号配置和设备配置，通过真实版本/发布接口控制草稿、即时生效和未来生效版本。
- 创建四个本轮专用设备用户：主客户已分配 ACTIVE 操作员、主客户未分配用户、主客户已分配但 DISABLED 用户、第二客户用户。跨客户用户分配至主设备返回 409。
- 临时 VPC Lambda 只负责固定范围的数据库观察和最终清理；凭据在 AWS 内访问，不下载数据库或 License 签名 Secret。所有业务准备均由实际管理接口完成。

## 3. 六域快照与数据库核对

| 域 | 实测核对 |
|---|---|
| Assignment | assignmentId、Customer/Site ID 与名称、Region=`APAC-TEST`、Subregion=`Singapore-TEST`、assignedAt 与当前 ACTIVE 授权窗口一致；endedAt=null |
| Device | ID、序列号、专属型号、实际 PATCH 的 alias 一致；firmwareVersion=null 与设备台账一致，本轮未验证固件版本写回 |
| License | wire 状态 ACTIVE、effective=true、version=3、有效日期、v1 签名与真实管理 API / DB 相同；签名载荷包含精确 UTC 时间、设备/客户绑定及排序后的 Entitlement；OTA_UPDATE → OTA 映射正确 |
| Configuration | 固定四字段完整返回；型号回退、设备优先、版本状态和生效时间行为见后表 |
| Device Users | 仅返回主客户有效分配的 ACTIVE 操作员；未分配、DISABLED 和第二客户用户均未进入快照。返回 PHC 与 DB 中该用户版本的 SHA-256 摘要一致 |
| Operational Status | 生命周期从 Assigned 到 Licensed；lastHeartbeatAt、运行状态原值及 300 秒同步节奏与云端记录一致。运行状态原值为 ACTIVE，**该值虽与 DB 相同，但不符合 REST Schema** |

实际叶证书、私钥、设备身份和服务端主机名验证均启用。两条 QoS 1 Heartbeat 的 seq=1/2、PROCESSED 及规范化 payload_hash 与实际报文对应，不以 PUBACK 替代业务结果。

`final-snapshot.redacted.json` 保留服务器字段与真实值，仅将 `deviceUsers[].passwordHash` 替换为明确的脱敏标记；因此该附件不是可重放报文，也不是一份通过 Schema 的原始响应。回执另外保留原始响应 SHA-256、内存中计算的 ETag、PHC 摘要及参数；Schema 校验在脱敏前完成。脱敏前原文没有保存到磁盘。

## 4. 配置、ETag 与设备用户版本

| 操作 | 实际结果 |
|---|---|
| 仅发布型号配置 | 返回 61s Heartbeat、31s Telemetry、2min Camera、71°C |
| 稳定域未变化时再次 Sync | 仍为 200 和完整六域；snapshotAt 更新，lastSyncTime 回显，不返回 304 或裁剪快照 |
| 发布设备定向 V1 | 覆盖型号配置，返回 45 / 15 / 3 / 74.5，ETag 改变 |
| 创建设备 V2 草稿 | 仍返回 V1，ETag 不变 |
| 发布设备 V2 | 返回 46 / 16 / 4 / 75.5，ETag 改变 |
| 发布未来生效 V3 | V3 已 PUBLISHED，但 effectiveAt 在未来，仍返回当前 V2，ETag 不变 |
| 新 Heartbeat | lastHeartbeatAt 更新；稳定域不变，ETag 保持不变 |
| 操作员密码及显示名更新 | 用户版本 2 → 3、PHC 摘要改变、ETag 改变；新密码验证成功，旧密码和随机错误密码均不通过 |
| 最新用户版本再确认 | 仍返回完整快照，ETag 不变；管理详情显示 deliveredEntityVersion=3、ACKNOWLEDGED、deviceApplyStatus=NOT_REPORTED |

设备用户在进程内按 DEC-004 复验 Argon2id v=19、m=32768 KiB、t=3、p=1、16 字节 salt、32 字节 hash。九次完整比较均执行正确密码与错误密码验证；证据不公开 PHC、salt/hash 原文或密码。

数据库 `device_user_sync_receipts` 保留 entity_version=2 和 3 两条记录，分别有 servedAt、后续 deviceReportedLastSyncAt 和 acknowledgedAt。未用通知发布或 ACKNOWLEDGED 推断设备已应用账号。

## 5. License 接收与状态边界

实际快照的有效 License、版本、签名和 signaturePayload 与数据库及管理 API 逐项一致。客户端收到后，以实际 snapshotEtag、License ID / version 提交 `licenseConfirmation.status=RECEIVED`，服务器将设备从 Assigned 迁移到 Licensed，并记录一条匹配快照绑定的 `device.license.received` 成功审计；相同确认重放返回 200，没有重复迁移。

本次没有取得设备侧可信 HMAC 验签密钥，也未将云端返回签名、DB 匹配或 RECEIVED 当作独立验签成功。未发送 VERIFIED，未产生 `device.license.verified`，设备没有进入 Active。License 状态 Active、设备生命周期 Licensed 和设备上报的 ACTIVE 运行状态是不同字段，不能互相替代。

## 6. 未通过项：REST 运行状态枚举

**发现：12 次成功 Sync 的 `operationalStatus.operationalStatus` 均为 `ACTIVE`。** 当前 [Sync OpenAPI](../../contracts/rest/device-sync-api.json) 允许的是 `Active` / `Maintenance` / `Suspended` / `Retired` / null。全部失败均定位此路径，非脱敏导致；原始 Schema 校验在响应仍包含完整 PHC 时执行。

例证：最终回执的 `schemaFindings` 保存各请求 requestId、时间和完整校验错误；原始 body 和 DB 最新态均保留 ACTIVE。数据比较与 Schema 检查分开记录，`businessGate=PASS` 不覆盖 `gate=FAIL_CONTRACT`。离线复核器的 PASS_RECONCILED 仅表示证据自洽，也不把实际接口失败升级为通过。

代码排查初步指向 [Heartbeat 写入](../../apps/ingestion-worker/src/heartbeat/handler.ts) 直接保存 MQTT 大写 operationalStatus，及 [Sync 组装](../../apps/cloud-api/src/device/sync.ts) 直接返回最新态原值。后续应修复 MQTT/REST 状态映射和历史值读取，保留 MQTT 与 REST 各自的规范枚举，部署后以新轮次重新实测；本次没有变更共享服务、数据库 schema、IAM/KMS、CA、Truststore 或调度。

另有自报 deviceId 等未知 Sync 字段返回 400；本轮未执行完整错误、跨设备证书、过期或撤证矩阵。

## 7. 失败轮次、恢复与清理

| 轮次 | 时间（北京时间） | 原始结果与处置 |
|---|---|---|
| attempt-1 | 19:48:56—19:49:23 | 调度读取失败 `events:describe-rule:FAILED`，尚未创建资源。原助手未保留 stderr，具体原因 UNKNOWN；后续直接读取及新轮读取成功。没有将其推定为某种超时 |
| attempt-2 | 19:51:19—19:54:32 | 取得真实完整快照；校验器错误地比较 JSON 字段顺序，导致配置误判。同时真实枚举问题成立。清理因自身 Outbox 未完成而被保护拦下；用户及观察器先删除 |
| attempt-2 recovery | [独立恢复回执](./evidence/rest-sync-2026-10-22/attempt-2/recovery.json) | 按精确失败台账重建临时观察器，待任务完成后删除本轮资源和六个归档版本；四个客户/站点记录按固定范围 SQL 软删除，并追加清理审计。未覆盖原 FAIL |
| attempt-3 | 19:59:24—20:06:46 | 修正为字段内容比较，并在清理前等待自身异步任务完成；业务内容全部匹配，契约仍 FAIL_CONTRACT，四项清理阶段均通过 |

各轮源码字节单独保存；前两轮按原始 sourceHashes 自校验，最终轮额外对照当前执行源码。详见 [准备及修正说明](./evidence/rest-sync-2026-10-22/preparation-notes.json)。

最终第 3 轮删除：一台设备、一张证书及公钥归属、一条分配、一份 License、三项 Entitlement、三条 License 历史、四个设备用户及两条分配、两条用户 Sync Receipt、两个配置和四个版本、15 条已发布 Outbox、两条 Heartbeat Receipt、最新态/生命周期、申请/Job/nonce，以及六个 License 归档对象的全部版本。主/控制客户与站点经真实 DELETE API 软删除，GET 回查均为 404。

第 2 轮的独立恢复同样完成设备、证书、业务数据和归档清理。两轮各自的 Cognito 身份、Thing、策略和临时 Lambda 均已不存在；四个精确自有 S3 前缀无剩余版本或删除标记，见 [14 项独立回查](./evidence/rest-sync-2026-10-22/cleanup-readback.json)。没有清空共享 SQS 或删除其他客户对象。

审计日志与 CloudWatch 日志保留，两轮合计四个客户及四个站点软删除记录作为审计关联墓碑保留。最终轮清理前可定位 39 条本轮业务审计，清理本身另产生记录。原有 3 台设备、4 张证书，以及总计 13 张表的本轮范围外行数/内容指纹在运行和清理前后相同；不据此宣称整个共享数据库或整个 S3 桶都做了快照验收。

## 8. 检查与复核

[validation.json](./evidence/rest-sync-2026-10-22/validation.json) 记录本地检查；[local-tests.log](./evidence/rest-sync-2026-10-22/local-tests.log) 为 36/36 测试。离线复核检查三个轮次、恢复记录、源码字节、九次六域比较、版本/ETag、用户确认、枚举失败及清理，所有原始失败保留。

```bash
node --import tsx docs/audit/evidence/rest-sync-2026-10-22/verify.mjs
node --import tsx --test scripts/rest-sync-smoke.test.mjs contracts/rest/device-sync-api.test.ts scripts/contract-suite.test.mjs
```

重新实测需使用新目录和测试环境权限；当前服务的已知契约问题未修复时，执行器完成清理后仍以非零退出码返回 FAIL_CONTRACT：

```bash
FDP_REST_SYNC_TEST=1 node --import tsx scripts/run-rest-sync-smoke.mjs \
  /tmp/fdp-rest-sync-fresh/receipt.json
```

## 9. 尚未验证

真实固件/安全存储、License 独立 HMAC 验签及 VERIFIED → Active、账号本地应用、实际命令/OTA、License 过期/撤销/密钥轮换、完整跨设备与异常矩阵、24 小时窗口、并发性能、其他 REST 操作和生产验收仍为 NOT RUN。当前 REST 枚举缺陷修复后的回归也为 NOT RUN。
