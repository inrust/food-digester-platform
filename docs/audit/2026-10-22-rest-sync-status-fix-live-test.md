# REST Sync 运行状态枚举修复与部署复测（2026-10-22）

## 结论

**限定范围验收通过：修复已部署测试环境，161/161 项实测检查 PASS，15 次成功 Sync 的响应 Schema 全部通过。** 新写入规范值、历史大写值只读映射、真实 Heartbeat 恢复及 ETag 一致性均已验证；独立 AWS 清理回读 7/7 PASS；19/19 个部署函数的固定 S3 版本完整对象 SHA-256 与 Lambda 摘要核对通过。

[原始实测回执](evidence/rest-sync-status-fix-2026-10-22/attempt-1/receipt.json)、[末次脱敏快照](evidence/rest-sync-status-fix-2026-10-22/final-sync-snapshot.redacted.json)、[独立清理回读](evidence/rest-sync-status-fix-2026-10-22/cleanup-readback.json)。

## 修复内容与版本

原问题及失败证据保留在 [上一轮完整 Sync 实测](2026-10-22-rest-sync-live-test.md)：151 项检查中 12 项响应 Schema 检查失败，实际 `operationalStatus.operationalStatus="ACTIVE"` 不符合 REST 契约。

修复提交：`a21008b73e23891c3c718183b38e4958d9259c5b`。

- [共享状态映射](../../packages/domain/src/device-lifecycle.ts) 显式转换 MQTT/历史大写值与领域规范值，未知值不作为运行状态输出。
- [Heartbeat 写入](../../apps/ingestion-worker/src/heartbeat/handler.ts) 将 `ACTIVE` / `SUSPENDED` / `RETIRED` 保存为 `Active` / `Suspended` / `Retired`；接收的 MQTT 原始报文及幂等 Hash 不变。
- [Sync 读取](../../apps/cloud-api/src/device/sync.ts) 兼容历史大写记录，映射后参与响应与 ETag；无有效最新态时使用既有生命周期回退。历史数据不做批量更新，未改数据库 schema。
- MQTT Schema 和 REST OpenAPI 均保持原值；这不是放宽契约，也不推进设备生命周期或 License 状态。

兼容性：修复后，历史大写存储与规范存储映射为相同 REST 值，稳定域一致时 ETag 相同。修复前以大写响应计算的旧 ETag 可发生一次变化；Sync 始终返回完整快照，设备应保存本次实际返回的 ETag。

## 测试环境部署

| 项目 | 结果与证据 |
|---|---|
| 精确提交完整 CI | [39778667012](https://github.com/inrust/food-digester-platform/actions/runs/39778667012) success；[元数据](evidence/rest-sync-status-fix-2026-10-22/github-ci.json) |
| 精确提交自动部署 | [39778666876](https://github.com/inrust/food-digester-platform/actions/runs/39778666876) success；[元数据](evidence/rest-sync-status-fix-2026-10-22/github-deploy.json) |
| 实际部署输入 | [已解析回执](evidence/rest-sync-status-fix-2026-10-22/deployment-inputs.json)，沿用 `immediate` 阶段、engine CPU 诊断开启，其余候选开关关闭 |
| CloudFormation | `fdp-test-app` 在 UTC `2026-10-22T12:57:42Z` 完成 `UPDATE_COMPLETE` |
| 完整对象部署摘要 | [最终版本回执](evidence/rest-sync-status-fix-2026-10-22/application-version.json)：19/19 PASS，固定 S3 VersionId / ObjectSize / FULL_OBJECT SHA256 与 Lambda CodeSha256 一致 |

[CDK diff / deploy 日志](evidence/rest-sync-status-fix-2026-10-22/deployment-diff-and-result.log) 仅有 Ingestion、Device API、Admin API、OnboardingDeadline 四个 Lambda 的代码资产变化，没有 IAM、数据库 schema、域名或 Truststore 变更。共享领域模块变更使相关 bundle 的源内容与摘要更新。

## 本地检查

[本地检查回执](evidence/rest-sync-status-fix-2026-10-22/local-checks.json) 绑定修复提交与九个变更源文件摘要。

| 检查 | 结果 |
|---|---|
| ingestion 全部测试、domain 全部测试、Sync 和 License Sync 回归 | 329/329 PASS |
| REST Sync 脚本与设备契约回归 | 37/37 PASS |
| CDK deployment-config 模板测试 | 缓存 pnpm 重跑 6/6 PASS |
| domain 构建、domain/cloud-api/ingestion 类型检查 | PASS |
| ESLint、Prettier、敏感信息扫描、diff whitespace | PASS |
| 模块边界、JSON Schema、OpenAPI bundle 新鲜度 | PASS |

本地 CDK 首次运行的 pnpm 包装器尝试从 npm 下载 `@pnpm/exe`，受网络限制在打包前失败，保留 [失败日志](evidence/rest-sync-status-fix-2026-10-22/deployment-template-attempt-1-fail.log)。使用本机缓存的 pnpm 10.20.0 后 [重跑通过](evidence/rest-sync-status-fix-2026-10-22/deployment-template-attempt-2-pass.log)，没有更改断言或测试超时。

修复前文档提交 `fc96f33b` 的 [部署 39777396732](https://github.com/inrust/food-digester-platform/actions/runs/39777396732) 在模板测试 30 秒超时，未进入 AWS 部署；[失败节选](evidence/rest-sync-status-fix-2026-10-22/previous-deploy-failure-excerpt.log) 保留原结果，不将本地重跑替代该远程失败。

## 测试方式与安全边界

环境为 AWS 账号 `065986019555`、区域 `ap-southeast-1`、`fdp-test-app`。在共享测试环境中新建独立软件设备、独立型号、两个 Customer/Site、一个有效 License、型号/设备配置及四类用户。正常业务通过真实 CSR、审批、项目 CA 签发、管理 API、MQTT mTLS 与 Device REST mTLS 执行。

历史兼容性检查是唯一专门的状态 fixture 写入：观察器要求本轮随机序列号对应唯一设备、最新态必须为 `Active`，事务中仅将该设备一行运行状态改为旧格式 `ACTIVE`。之后实际调用 Sync 确认返回 `Active`，通过新的真实 Heartbeat 恢复规范存储。不会修改其他设备或生命周期；不把这次注入描述成真实 MQTT 写入。

所有 Device User PHC 验证材料在内存中校验后脱敏，审计只保留摘要与参数。私钥、JWT、密码和 License 签名密钥不写入审计；设备端独立 License HMAC 验签未执行。

软件模拟器的首个 Heartbeat 沿用当前样例的 `operationalStatus=ACTIVE`、`licenseStatus=ACTIVE`。这属于测试输入，不能证明首次接入时已有有效 License；真实许可事实仍以之后管理 API 签发的 License 和设备生命周期为准。未许可首次接入及维护态的 MQTT 表达仍是 [接口文档](../api/iot.bio-nexa.com.md) 所列待明确边界，本次未扩充 MQTT 枚举。

## 实测结果与云端核对

时间：UTC `2026-10-22T13:02:22.528Z`～`13:09:43.670Z`，北京时间 21:02～21:09。

| 身份 | 本轮独立对象 |
|---|---|
| 序列号 / 型号 | `syncprobe-ba0cbdd348d2cc13` / `SYNC-BA0CBDD348D2CC13` |
| Device / Thing / MQTT Client ID | `75579697-6040-4498-b4df-b7f8f09040de` |
| 主 Customer / Site | `643fe8d1-0f3e-4b38-a162-31cede4c8d1d` / `1eb4f582-749c-4c6c-a08c-56a57ae1a3d2` |
| License | `992d228e-ee38-4a39-ad35-4da5c6c3a2da`，版本 3，实际 Draft→Issued→Active |
| 已分配用户 | `b21a684b-814b-48ac-b1ca-3a30eb0bd8b0`，版本 2→3 |

| 检查 | 结果 |
|---|---|
| REST Sync 契约 | 15 次 200 + 1 次未知字段 400，全部符合原契约；没有放宽 Schema |
| 六域业务快照 | 九次完整比较全部匹配 DB：分配、设备、License、用户、配置、运行状态 |
| 新 Heartbeat 写入 | 三条 MQTT 原始 `ACTIVE` 报文均被处理，原始规范化 Hash 与云端幂等回执一致；DB 写入 `Active` |
| 历史兼容读取 | 仅本设备一行注入 `ACTIVE`；Sync 返回 `Active`，观察器仍读到 DB `ACTIVE`，证明读取没有回写 |
| 恢复与 ETag | 第三条真实 Heartbeat 恢复 DB `Active`；注入前、历史读取、恢复后 ETag 相同 |
| 配置 | 型号回退、设备优先、草稿不生效、发布新版本和未来版本不生效均通过；生效变更才改变 ETag |
| 用户 | 仅本客户已分配 ACTIVE 用户下发；未分配、DISABLED、外客户均排除；新密码可验证、旧密码被拒绝 |
| 用户交付状态 | 版本 2、3 的 served/ack 与管理端一致；`ACKNOWLEDGED`、`NOT_REPORTED`，未声称本地应用 |
| License | `signature` / 完整 `signaturePayload` / Entitlement 与真实管理 API、DB 相同；`RECEIVED` 幂等推进到 `Licensed`，未发送 `VERIFIED` |
| 隔离与部署稳定 | 跨客户 Site 400、外客户用户分配 409；测试前后八个处理器摘要相同；范围外业务数据指纹一致 |

维护态、其他历史大写状态及未知值的映射由本地契约回归覆盖；本轮在线历史注入只验证 `ACTIVE`，没有在线模拟其他运行状态。

## 清理

四组自动清理全部 PASS：删除设备、证书、Thing/Policy、3 条上行回执、分配、License、3 条 License 历史和 3 条 Entitlement、两套配置与四版本、四个设备用户及两条同步记录、15 个本轮 Outbox、申请/Job/nonce；两个 Customer 和两个 Site 经真实管理 API 软删除并 GET 404；Cognito 测试身份和临时观察 Lambda 已删除。两个本轮客户的 License 归档前缀已清空，包括对象版本和删除标记。

独立 AWS 回查共 7 项全部 PASS：证书、Thing、Policy、Cognito、临时 Lambda 均不存在，两个归档前缀为空。范围外 13 类业务/身份指纹保持一致。39 条清理前已记录的本轮审计、后续清理审计、停用管理员行、Customer/Site 软删除墓碑及 CloudWatch 日志按审计设计保留；这些不作为可用设备资源。

## 制品读取边界与失败保留

首轮采用 SDK、8 MiB 分段、45 秒请求预算；19 个函数中仅一个完成完整字节核验，18 个标记 `rangeReadFailed`，最终 [BLOCKED 回执](evidence/rest-sync-status-fix-2026-10-22/application-version-attempt-1-blocked.json) 和 [日志](evidence/rest-sync-status-fix-2026-10-22/version-attempt-1.log) 保留。执行器没有保存每次底层异常，故具体失败原因记为 **UNKNOWN**，不推断为部署、权限或业务失败。

对同一已部署 Ingestion 资产固定版本的 [CLI 单字节](evidence/rest-sync-status-fix-2026-10-22/asset-byte-cli-probe.json) 与 [SDK 单字节](evidence/rest-sync-status-fix-2026-10-22/sdk-byte-probe.json) 读取均成功。第二轮使用 CLI、256 KiB 分段、90 秒预算；在最后报告 `140/326` 分段后切换核验方式，保留 [中断记录](evidence/rest-sync-status-fix-2026-10-22/version-attempt-2-interruption.json) 与 [进度日志](evidence/rest-sync-status-fix-2026-10-22/version-attempt-2-interrupted.log)，不接纳未完成的字节证明。该读取器及其 8 个临时片段目录已清理，没有云端写入。

切换依据：[本轮新 Ingestion 资产](evidence/rest-sync-status-fix-2026-10-22/asset-checksum-probe.json) 和 [既有未变更资产](evidence/rest-sync-status-fix-2026-10-22/unchanged-asset-checksum-probe.json) 均提供固定 VersionId 的 `FULL_OBJECT SHA256`，与相应 Lambda `CodeSha256` 一致。第三轮使用仓库既有 `s3-full-object-sha256` 模式，19/19 个函数的固定 S3 VersionId、对象大小、完整对象 SHA-256 与 Lambda 摘要均核对通过，见 [最终日志](evidence/rest-sync-status-fix-2026-10-22/version-attempt-3-pass.log)。该方式不声称本轮在本地重组了全部 ZIP 字节。

前两轮摘要读取与隔离实测部分时间重叠；八个业务处理器在实测前后摘要一致，最终核验器已将这些摘要与固定资产证明逐一对照。

## 离线复核与版本边界

归档使用 [SHA-256 清单](evidence/rest-sync-status-fix-2026-10-22/manifest.json)；[离线核验器](evidence/rest-sync-status-fix-2026-10-22/verify.mjs) 对照执行提交、冻结源文件、配置回执、部署摘要、九次数据库比较、三条 Heartbeat Hash 和清理回读，并检查上一轮所有封存字节及 `FAIL_CONTRACT` 保持不变。

[最终离线核验结果](evidence/rest-sync-status-fix-2026-10-22/verification.json)：`PASS_RECONCILED`。本轮证据与历史失败记录分开封存。

```bash
node --import tsx docs/audit/evidence/rest-sync-status-fix-2026-10-22/verify.mjs
```

原始响应在内存中先做契约校验及 ETag 计算，再脱敏设备用户验证材料。归档保留 API Gateway requestId、原响应 SHA-256、计算得到的 ETag 和 PHC 摘要；不使用脱敏占位符重新计算原始 ETag，也不能从脱敏文件还原原始验证材料。

部署修复版本为 `a21008b7`。后续文档归档提交只修改接口说明、审计证据及字节保留规则，运行时代码与该部署版本相同；限定范围的核验结果不扩展为整个应用或生产验收。

## 未覆盖范围

本次限定结论不覆盖真实固件、独立 License HMAC `VERIFIED → Active`、设备用户本地应用、实体动作、OTA 下载与安装、其余 REST 操作、24 小时轮换超时回退、完整 QA-09 或生产验收。用户 `ACKNOWLEDGED` 仅表示快照确认，不能证明本地应用；`RECEIVED` 仅推进到 `Licensed`。
