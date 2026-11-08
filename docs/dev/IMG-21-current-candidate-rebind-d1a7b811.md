# IMG-21 当前候选复验与 G3、执行包重新绑定

2026-11-08。本次只完成当前候选的云端本地复验和目标执行包重新绑定，不执行真实目标验收。开始时 main 工作区干净，HEAD 为 `d1a7b81196d60ec320e760da3d18de403563fc12`；仓库中此前的 `69c76e1d`、`5742d6ba` 和目标环境材料已作为历史记录保留。

## 交付结论

**G3=PASS_LOCAL，绑定应用候选 d1a7b811；G4=NOT_RUN。** 本批不修改业务后端、平台页面、契约、V1 权限矩阵或 IaC，不调用真实云端，不部署、连接或迁移目标库、不启用设备、不推送。App 实现与真机验收由第三方负责。

采用两个本地提交：先封存不可变 G3 证据，再引用该提交重新生成执行包，避免证据自引用。应用候选、G3 证据提交和验收协议版本分别记录：

| 绑定项 | 当前值与校验 |
|---|---|
| 应用候选 | `d1a7b81196d60ec320e760da3d18de403563fc12` |
| 不可变 G3 证据提交 | `1b1b879ffcf34be7cebd6fe87b8301ae5bd21356` |
| 执行协议摘要 | `76f5bc57976dfe2a566eec3f71fa0d28b0ff0f93da4195f0876b3dc2ecfd188b`，输入和 receipt 必须一致 |
| 完整验证输入 | 1713 份；运行前后无漂移，逐字节核对应用候选 Git 对象 |
| 持续交付源校验 | 1693 份，覆盖业务、契约、IaC、共享工具和配置 |
| 独立准备工具 | 精确限定 20 份，通过协议摘要、生成包 manifest 和本地回归校验，不扩大到业务源 |
| G3 封存产物 | 13 份，包含完整日志、七份新 receipt、清单和报告；从证据提交读取 |
| 执行包 | 12 文件、44 个目标用例；AR12 保留唯一源码不可达 N/A 和其余五个必测目标变体 |

## 本地验证

[完整 G3 报告](../audit/device-image-G3-d1a7b811-local-2026-11-08.md)及[原始证据](../audit/evidence/2026-11-08-device-image-G3-rebind-d1a7b811/result.json)封存在首个提交。完整 `pnpm verify` 于北京时间 19:08:52～19:19:42 执行，退出 0：

| 检查 | 结果 |
|---|---|
| 全量 verify | PASS，22 阶段 |
| Vitest | PASS，221 文件 / 2177 项 |
| 契约 / 脚本 | PASS，319 / 1625 项 |
| 默认 / 严格浏览器 | PASS，48 / 144 次 |
| 原型回归 | PASS，24 项 |
| 七专项 receipt | PASS；均为本轮新产物，baselineCommit 精确等于 d1a7b811 |
| 运行源、类型、构建、Schema、迁移漂移、OpenAPI、离线 CDK | PASS；未连接目标数据库或 AWS |

重绑定后检查记录于[本批机器记录](../audit/evidence/2026-11-08-device-image-G3-rebind-d1a7b811-preparation/result.json)：

| 检查 | 结果 |
|---|---|
| 目标组包专项 node:test | PASS，103 项；包括业务/IAM 漂移拒绝、证据绑定、过期协议、AR12 必测分支与 N/A 约束 |
| 全量 `pnpm test:scripts` | PASS，1625 项，0 失败/跳过 |
| AR12 完整 evidence-image-query 回归 | PASS，34 项；10 份权限相关源摘要匹配候选，不缩为七项子集 |
| ESLint、四个 MJS 的 Prettier、边界、证据、敏感 sink、secret 检查 | PASS |
| `--generate` / `--check` | PASS_OFFLINE_PACKAGE；12 文件 / 44 用例，真实云调用数 0 |
| 空输入 `--admission` | 预期退出 2 / BLOCKED，35 项缺失；不是 G4 失败或通过 |
| 空回执 `--receipt` | 预期退出 2 / NOT_RUN |
| 旧 69c76e1d 输入 | 预期退出 1 / FAIL：INVALID_INPUT_BINDING、DEPLOYED_CANDIDATE_MISMATCH、deployment/migration/runtime proof 失配；保留原始输出，不修改旧文件 |

全量 verify 验证的是应用候选 d1a7b811 内的版本；后续协议工具变更由上述独立检查覆盖，不声称最终文档/证据提交重新执行了全量 verify。Vite 分块及 NO_COLOR/FORCE_COLOR 警告保留，未降低测试范围或重试要求。

## FAIL、BLOCKED、NOT_RUN 明细

- 未解决的本地门禁 FAIL=0，本地 G3 BLOCKED=0。旧输入校验输出的 FAIL 是预期拒绝路径，原始五项错误及 21 项历史输入缺项仍归档，不包装成目标接口失败。
- 当前 d1a7b811 输入模板的 35 项均未提供或重新绑定：环境/入口、部署/运行版本、迁移证据、原生存储、设备/客户、mTLS/MQTT/JWT 身份、权威写入口、授权范围/时间窗、故障/24 小时窗口、规模/SLA、序号预留和清理方案。提供方及逐项原因见 inputs.template.json 和 template-admission.json。
- 旧 69c76e1d 记录中的 14/35 输入、目标迁移、公开入口及原生前置观察仍为历史事实。本轮没有重新访问目标，不能直接将其 SHA 改为 d1a7b811；也不据此重复迁移。
- 当前候选 Hosted CI/部署和实际版本核验、真实五个预览接口/S3/MQTT、44 个完整 G4 用例、原生多连接/多实例并发与撤权、故障恢复、真实 24 小时终态、容量/首帧/成本均 NOT_RUN。
- AR12/no-media-permission 仍仅为源码约束的 NOT_APPLICABLE，不计目标 PASS；源码/回归漂移则恢复 BLOCKED。其余五个目标变体不得免测。
- App/相机/设备端及真机验收由第三方负责，不是本批云端交付内容。

## 修改范围与下一任务

更新目标组包工具的候选与证据提交，刷新 AR12 本地依据并使测试夹具读取统一路径；同步指南、口径文档、开发计划及六个受影响的生成文件，补齐本地回归证据。旧 G3、AR12 和 G4 目标历史材料不覆盖。

下一可执行任务是 IMG-21 **当前候选的目标准入材料准备与版本核对**：由责任方按新 sourceCommit/protocolDigest 提供部署版本与证明、重新确认已有迁移状态及其可复用依据，准备隔离身份/设备、权威写入口和执行窗口。未取得单独真实目标执行授权前，继续只做离线输入/证明校验；不得因历史迁移成功而自动重跑迁移或启动目标验收。G4 需真实执行证据才能升级。
