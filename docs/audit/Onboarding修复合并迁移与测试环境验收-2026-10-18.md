# Onboarding 修复合并、迁移与测试环境验收（2026-10-18）

本轮按“目标库历史重复检查 → 合并 main → 数据库迁移 → 测试环境部署 → 真实 API 验收 → 夹具清理与复核”执行。业务行为为：未提交过的序列号直接创建待审申请；任何状态下已提交过的序列号返回已提交提示；管理员批准时才创建设备台账。

执行证据位于 [attempt-1](evidence/onboarding-deploy-2026-10-18/attempt-1/)，最终机器摘要为 `rollout-validation.json`，文件字节清单为 `manifest.json`。此前的[本地修复报告](Onboarding首次申请去库存前置修复-2026-10-18.md)及其失败、基线复验记录保持原样；该历史报告中的 NOT RUN 是当时状态，本报告记录后续目标环境执行结果。

## 版本与范围

- 合并 PR：[inrust/food-digester-platform#1](https://github.com/inrust/food-digester-platform/pull/1)，远程 main 快进至 `24317c4cbe22318666c2ac7caae9e82f7e437eaa`。
- 本次实际迁移与部署源码均为上述 SHA。后续审计文档提交不代表重新部署了应用。
- 目标为 AWS 测试账户 `065986019555` / `ap-southeast-1` / `fdp-test-app`，数据库 `fdp-test-db` 的 `fdp` 库。没有执行生产发布。
- 本轮使用合成设备和临时管理员调用真实测试 API；不使用用户的实物序列号创建额外申请。没有验证实物固件、首 Heartbeat 或完整 QA-09 性能 Gate。

## 目标库检查与迁移

合并前固定只读执行器 `fdp-test-qa09-readonly-runner:83945778-3da5-4699-ae24-c87577e74476` 检查所有状态的历史申请：重复序列号组为 **0**，申请总数为 **0**。原有设备为 2 条、证书为 3 条。迁移前 Migration Gate 为 BLOCKED，原因仅为尚未应用本次新增迁移；该原始结果未改写。

新增迁移 `20261018090000_onboarding_request_serial_unique` 创建全状态序列号唯一索引，再移除旧 PENDING 部分唯一索引。没有删除历史重复记录或修改业务数据来促使迁移通过。

| 项目 | 执行结果 |
|---|---|
| 迁移源 | Git 归档 `24317c4c…`，SHA-256 `d4e4934de6cbfb308de23a9c63b691588cfb270cfd9a6eb1275a1d6e8256e11d` |
| 固定 S3 版本 | `migration/source.zip` / `AzkX6zYfUABdNguUwltNTgZ9c94lLG0B` |
| 迁移执行 | `fdp-test-migration-runner:0751ec27-537f-4ec5-86e9-f1a52c6d6664`，SUCCEEDED |
| 迁移与字典种子 | PASS，41 条迁移，未完成迁移 0，5 个角色，ESG 种子检查通过 |
| 独立迁移后复核 | `fdp-test-qa09-readonly-runner:6ce1fb12-a47f-4530-bd9d-5e9b5838d55c`，query/schema/migration Gate 均 PASS |
| 索引与数据保留 | 全状态唯一索引存在，旧部分索引不存在；所有业务表记录数及摘要与迁移前一致，仅迁移历史从 40 条增至 41 条 |

证据：`db-before.receipt.json`、`migration-artifact.json`、`migration-upload.json`、`migration.receipt.json`、`migration-verification.json`、`db-after-migration.receipt.json`。

## 测试环境发布与源码绑定

GitHub Actions 因账户账单或额度限制未启动作业，故使用已授权的本机 AWS SSO 身份执行仓库标准命令 `node scripts/esgiot-cdk.mjs deploy AppDependencies`。没有将 GitHub CI 记为通过。

CDK 差异仅为 18 个 Lambda 的 Code 资产，没有 IAM、网络或数据库资源变更。部署于北京时间 17:44:44 完成，退出码 0，CloudFormation 为 UPDATE_COMPLETE。独立读取线上原始模板，与当前构建的整份模板 JSON 一致，共 255 个资源。

19 个 Lambda 均为 Active / Successful；本机当前构建文件树与 ZIP 内文件逐项一致，ZIP 的 SHA-256 与线上 Lambda `CodeSha256` 一致。18 个包使用 CDK 本轮发布的原始 ZIP 缓存；未变化的 archive 包使用 Lambda 实际下载包。没有仅凭栈更新成功就声称源码版本一致。

证据：`cdk-diff-summary.json`、`cdk-deploy.execution.json`、`cdk-deploy.log`、`deployed-template-verification.json`、`deployed-version.json`、`version-verification-attempt3.log`。

## 真实 API 流程验收

设备序列号为 `qa09-4e64061a51812c7c-onboarding`，申请 ID 为 `7dd81abe-08e5-4e25-a299-c0563c5be7a6`，批准后设备 ID 为 `c85a3fca-8a0c-4479-b465-ac76cef3d7fc`。临时管理员通过真实 Cognito SRP 与首次改密挑战登录，以 PlatformSuperAdmin 权限执行审批；没有复用人员密码或把令牌、CSR、私钥写入证据。

| 操作 | 结果 |
|---|---|
| 管理端查询该序列号 | 200，台账 0 条 |
| 首次 POST `/api/v1/device/onboarding/request` | **201 / PENDING**，创建申请 |
| 待审时重复 POST | **409 / CONFLICT**，已提交提示 |
| 设备签名查询状态 | 200 / PENDING |
| 批准前再次查询台账 | 200，仍为 0 条，申请阶段不创建设备 |
| 管理员读取详情、携带 If-Match 批准 | **200 / APPROVED** |
| 批准后查询台账 | 200，恰好 1 条 OnboardingApproved 设备 |
| 批准后重复 POST | **409 / CONFLICT** |
| 设备签名轮询、领取证书 | 200 / APPROVED，设备 ID 正确，签发证书匹配本地私钥 |
| 管理员查询发证状态 | 200，Provisioning Job 为 **COMPLETED** |

API 验收 **18 项检查全部 PASS**，北京时间 17:52:08–17:53:38。每个 HTTP 操作保存状态码、网关追踪 ID 和脱敏响应摘要。证据为 `acceptance.receipt.json`、`acceptance.execution.log`。

## 清理与最终 Gate

临时 IoT 证书已停用、解绑并删除，Thing 和独占策略已删除；临时 Cognito 管理员已注销并删除。独立查询四类资源均返回预期不存在错误，见 `cloud-cleanup-verification.json`。

数据库夹具清理与独立复核均 **PASS**。清理构建为 `fdp-test-onboarding-fixtures-20261018:751d23f9-787f-4383-8c65-ba5efbee9289`，限定本次序列号、申请 ID、设备 ID、单个证书 ID，要求申请 APPROVED、Job COMPLETED、设备未分配客户、云资源删除已验证。在串行化事务内仅删除本次申请、设备、证书、公钥、Job、状态历史各 1 条及 6 条签名 nonce，校验关联表内其他行摘要未变；审批 SUCCESS 审计保留，审计 actor 与 reviewed_by 一致，已领取证书与 Job 证书 ID 一致。其本地 SQL 集成测试 3 项通过，覆盖范围约束、精确删除与 PROCESSING 时回滚。

最终固定只读复核 `fdp-test-qa09-readonly-runner:c6e12cf2-7764-407d-852d-bc08ae2bcd3e` 的 query/schema/migration Gate 均 PASS。原有设备仍为 2 条、证书仍为 3 条、申请恢复为 0 条；所有设备及 onboarding 关联表摘要与执行前一致。全库摘要仅以下三张表发生变化，其余表均一致：迁移历史 40 → 41；执行期间审计记录 5148 → 5153；限流记录 2 → 6。审计及限流记录不作为业务夹具删除。

两个本轮临时 CodeBuild 项目均已删除并验证不存在；既有只读项目的 source/environment 已恢复，角色、网络、日志和其他稳定配置与执行前一致。证据为 `fixture-cleanup.receipt.json`、`db-after-cleanup.receipt.json`、`fixture-project-cleanup.json`、`linux-verify-project-cleanup.json`、`readonly-project-restored.json`。

本轮限定 Gate 为 **PASS_ONBOARDING_TEST_ROLLOUT**。全部收据的版本、计划、ID、状态、原有数据保留和清理条件由 `validate-rollout.py` 联合校验；密钥扫描、生产日志 sink 检查和审计执行器语法检查均通过。原始日志保留字节，`.gitattributes` 仅对本轮证据 `.log` 关闭空白诊断。

`fullQa09Accepted=false`、`productionReady=false`。测试环境 API 流程通过不等于完整 QA-09、实物设备或生产验收通过。

## 保留的失败、跳过与限制

- 原完整 Vitest 为 1681 通过、19 失败；同名 19 项 CPU_SPAN_PROFILE_COVERAGE / CPU_CLOCK_ALIGNMENT 失败在修改前干净基线复现。本地整体 Gate 继续为 PARTIAL，不放宽门槛。
- 合并 SHA 的 GitHub [CI](https://github.com/inrust/food-digester-platform/actions/runs/39115581450) 与[部署工作流](https://github.com/inrust/food-digester-platform/actions/runs/39115581454) 因账单或额度限制未开始步骤，保留失败状态。
- 独立 Linux CodeBuild 在 DOWNLOAD_SOURCE 因指定独立 S3 对象版本无读取权限失败。用户授权的精确临时策略也因当前 SSO 缺少 `iam:PutRolePolicy` 未生效。按用户“必须管理员授权则跳过”的指示跳过该测试，验证项目已删除，临时策略经复核不存在。
- 自动审批审查拒绝了“用验证包覆盖共享 `migration/source.zip`”的方案，理由是可能被后续迁移误用；该操作未执行。本轮正式迁移另行上传的是真正的、绑定合并 SHA 的迁移归档，保留固定版本和摘要。
- `esgiot-dev` 首次 StartBuild 被显式拒绝，未产生迁移；随后使用既有授权 `esgiot-infra` 执行，未修改角色或权限边界。
- 版本核验第 1 轮 S3 下载超时、第 2 轮慢速下载被中止；第 3 轮使用发布 ZIP 缓存与线上摘要完成全部字节核对，原失败和中断记录均保留。
- 迁移后只读快照首轮收集早于构建完成，未生成收据；待 SUCCEEDED 后重新收集并通过。
- 清理执行器本地首轮夹具漏填 operation_id 后修正，3 项测试通过；目标启动前两次断言分别遇到 AWS 默认 `insecureSsl=false` 和无序标签返回，仅修正配置比较方式，两次均未启动清理构建。

数据库迁移已生效。回滚旧应用前仍须处理“无库存 PENDING 申请不能被旧审批代码审核”的兼容边界；不得以删除真实申请或强改生命周期代替处置。本轮未执行回滚。
