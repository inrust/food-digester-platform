# QA-09 自然生命周期与 Telemetry 阶段观测实施记录（2026-10-05）

本轮完成应用实现、协议升级、本地回归和目标复验材料。**工程子 Gate READY；新版本 AWS 业务复验 NOT RUN；完整 QA-09 PARTIAL。** 新代码尚需人工推送、同 SHA 部署与19个不可变工件核对。用户确认没有测试设备验签配置，因此真实独立 HMAC 验签及 Licensed→Active 仍 NOT RUN。本轮没有修改 IAM/KMS、云资源或测试业务数据。

## 已实现与变更文件

| 范围 | 文件与结果 |
| --- | --- |
| 自然生命周期 | `apps/cloud-api/src/device/license-sync.ts` 新增；`sync.ts`、`sync-handler.ts` 接线。有效许可证快照的明确 RECEIVED 驱动 Assigned→Licensed，后续已认证设备的 VERIFIED 声明驱动 Licensed→Active；领域历史、运行镜像与确认审计同事务。 |
| 交付与拒绝条件 | 设备/证书/分配/许可证行锁；现有审计保存版本、etag、指纹、签名摘要与归属绑定。24小时边界、重复幂等、换证/撤销/改版/重分配/暂停/退役拒绝。仅服务端准备响应或 lastSyncTime 不转换状态。 |
| 准确签名输入 | Sync 新增完整 UTC `signaturePayload`，修复原日期字段无法重建 DEC-020 HMAC 的缺口；保留日期展示字段，Draft 无签名为 null。 |
| 固定观测 | `packages/observability/src/data-path.ts`/`index.ts`；`apps/ingestion-worker/src/ingest/{pipeline,handler,receipt}.ts`、`telemetry/handler.ts`、`runtime/ingestion-entry.ts`；`apps/cloud-api/src/admin/device-console/{service,handler}.ts`、`runtime/{admin-lambda,lambda-entry}.ts`。根事务/嵌套回调、具体SQS结果与API查询阶段分开记录。 |
| 协议治理 | `contracts/contract-version.json`、REST Sync片段/统一bundle/两份契约测试；新增0.13.0基线和旧审批映射归档，现行映射比较0.12.0→0.13.0，遵循既有DOM-01/DEC-020。旧基线未改，未重新批准或改变签名算法/业务生命周期。封闭响应变化保守归类为版本升级，旧固件兼容不得假定。 |
| 本地验收 | 新增 `license-sync-lifecycle.test.ts`、`data-path.test.ts`；补 console/receipt 集成测试；QA-02执行器纳入新增确认用例和409状态；旧审批映射仍可对原基线复验。 |
| 目标驱动 | `scripts/qa09-natural-lifecycle-observation.mjs`及测试、normal/continuation驱动，真实 RECEIVED及管理回读，拒绝无对应快照。新增 `qa09-data-path-evidence.mjs`及测试，只读采集本轮固定日志元数据和20序号覆盖、特定重投关联。 |
| 文档 | [协议与部署手册](../dev/QA-09-自然许可证确认与Telemetry阶段观测.md)、QA-02协议治理文档、管理后台任务清单和本报告。全部文件清单见证据目录的 changed-files.txt。 |

本机没有独立设备验证配置，真实驱动不会构造 VERIFIED，不会播种 Active。PGlite测试使用已知本地测试密钥验证准确载荷，不是AWS/固件独立验签证据。服务端只信任已认证设备声明，不提供远程固件证明。

## 测试命令与结果

证据：[本轮目录](evidence/qa-09-lifecycle-telemetry-2026-10-05/)。保留初次失败输出，修正后以 final 回执为准。

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run --maxWorkers=4` | PASS：167文件、1358项。 |
| `pnpm exec vitest run packages/observability/test apps/cloud-api/test/license-sync-lifecycle.test.ts apps/cloud-api/test/device-sync.test.ts apps/cloud-api/test/admin-device-console.test.ts apps/ingestion-worker/test` | PASS：28文件、185项；其后34项最终增量再次PASS。 |
| `pnpm test:contracts` | PASS：302项。 |
| `pnpm test:scripts` | PASS：466项（最终回归）。本地mTLS broker需要回环监听，完整复跑在允许监听的环境执行。 |
| `pnpm test:device-contracts <device-contract-gate.json>` | PASS：11类MQTT、8个设备操作、168个未替换真实Handler响应；10文件98项，另治理19项。仅本地契约Gate。 |
| `pnpm typecheck` | PASS：21/21任务。 |
| `pnpm build` | PASS：14/14任务；最终输出见 build-final.log。 |
| `pnpm lint` / `pnpm openapi:check` | PASS。 |
| `pnpm check:sensitive-sinks` / `pnpm check:secrets` | PASS；观测只经脱敏logger输出固定元数据。 |
| `pnpm check:runtime` / `pnpm check:cdk` / `pnpm format:check` | PASS：129个生产操作与OpenAPI一致，CDK资产/接线Gate、格式全部通过。 |
| `aws sts get-caller-identity --profile esgiot-readonly` | 只读预检PASS：账号065986019555，FDP-ReadOnlyOps；未启动本轮AWS夹具。 |

新增反证覆盖：未提交服务端回调、未知etag/跨设备、版本/签名变化、证书轮换、有效期/撤销/分配变化、24小时含等号边界、Suspended回放、并发确认不重复历史、审计故障回滚、Draft拒绝；观测并发上下文不串线、日志输出失败不改重试、原始错误不泄漏、根事务返回后独立读取持久结果、嵌套事务外层回滚、重投关联原receipt以及20序号缺失失败关闭。

初次失败分别是console测试调用签名错误、旧契约测试期望/基线/bundle未同步、沙箱拒绝回环监听。已修正测试接入并完成版本治理，历史失败日志保留；没有放宽mTLS、状态覆盖或实际响应校验来换取绿色。

## Gate、未决风险与下一动作

- 工程交付 READY：代码/契约/测试/手册和复验驱动已准备，最终日志及哈希清单归档；本地提交SHA以本轮Git提交及最终回复为准，不人工伪造自身SHA。
- 新版本部署/19工件绑定/目标 RECEIVED/Telemetry阶段与性能复验 **NOT RUN / NO RECEIPT**。仓库AGENTS.md要求人工GitHub Desktop推送，Codex未推送。
- 真实独立HMAC及Licensed→Active **NOT RUN_NO_DEVICE_TRUST_CONFIGURATION**。用户已答“无”，不重复索取配置，不使用服务端验签或数据库改Active冒充设备验签。
- 观测可能增加日志量/延迟；`includesConnectionWait`不是纯连接等待测量，根事务完成日志是驱动返回时点。需新版本20样本阶段证据才能判断瓶颈；本轮未扩容，API/Ingestion仍pool1、Device API沿用pool2，统一63/70预算不变。
- 旧版本正常窗口Telemetry P95 7635ms **FAIL**仍保留，Command2017ms为旧版本子范围PASS，不覆盖本轮。三个JWT401状态契约、117全业务语义、全部合法写分支与完整负载等原未决项仍开放。本轮未重跑浏览器/五角色或替换旧报告。
- 队列特定重投还需现有运维通道前置；只读采集器不授予权限，未提交时明确NOT RUN，被拒绝时BLOCKED；IAM/KMS问题由管理员处理。
- Sync新增封闭响应字段可能被严格旧客户端拒绝。回滚需停新确认、核对旧应用工件；已写生命周期及审计不会随代码回滚自动恢复，不能直接批量降级。

**下一可执行任务**：人工推送本轮最终提交后，核对同SHA CI/Deploy/Amplify与19工件，用新前缀运行normal驱动（真实RECEIVED及管理员回读、20Telemetry/20Command），采集阶段日志、只读数据库与S3证据，完成夹具清理及最终版本绑定。真实Active在设备独立验签配置可用时另行补验。完整QA-09保持PARTIAL，八套正式领域证据Gate不因本地通过而关闭。
