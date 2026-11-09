# MC03 冻结与版本接收协议

当前批次只做本地候选冻结、质量复验和接收协议。旧 G4 `--cloud-admission` / `--cloud-receipt` 仍走原 strict 规则：部署 SHA 必须等于应用候选 d1a7b811。V2 通过独立入口显式选用；V1 输入和旧失败不自动升格。App、真机、扩展44项均不作为核心云端 CF01/02/03 Gate 前置。

## 候选与证据

- **应用候选**：d1a7b811；保留原 G3 证据 1b1b879f，核验1693交付源及8个构建输入。它是应用身份，与当前工具源码提交及仓库候选分开。
- **独立工具源码**：4a99ce1e 的 `tools/img21` 整树。Writer、Verifier 清单分别绑定 bare entry SHA256、构建输入闭包和本地测试；两者只证明本地代码，真实 ZIP 和发布版本仍缺。完整权威写入口是原19个应用入口加 Writer；Verifier 不具有写权限。
- **仓库与协议候选**：本轮协议实现提交。先提交源码，再在该提交上运行 `pnpm verify` 的22阶段、7份专门回执及工具 typecheck/test/synth/ZIP/复算、协议回归；结果和日志另提交。完整 Git tree/库存与非 docs 文件内容摘要绑定；证据提交只允许向 MC03 专用证据目录写入，不豁免其他运行/构建源。旧 G3 固定20个 preparation inputs 的范围不变。新协议依赖显式纳入协议摘要。
- **历史部署**：69c76e1d 是保留的历史观察 SHA。离线重算1693交付文件、1713完整检查输入及8个构建树，禁用重命名折叠，留存两侧实际路径差异（12项完整检查输入不同）。对照结果仅源比较；不声称该部署是 d1，也不构成新观察、发布审批或真实 G4。

[冻结目录与结果](../../docs/audit/evidence/2026-11-09-device-image-MC03/result.json)。重复验证 `node scripts/device-image-candidate.mjs --check`。新候选源码或工具一旦改动，重新冻结和执行适用质量检查；不能沿用旧 digest。

## V2 入口

```sh
node scripts/device-image-candidate.mjs --admission-v2 RUN/inputs.json
node scripts/device-image-candidate.mjs --receipt-v2 RUN/receipt.json RUN/inputs.json
```

V2 仍使用旧22项核心输入和原证据/用例/清理校验，新增输入顶部 `versionBinding={formatVersion:2,mode:"STRICT",catalogRef}`。catalogRef 固定指向仓库中已提交的 MC03 冻结清单及文件 SHA；其余 proof refs 是 RUN 目录内的相对路径和 SHA256。新协议摘要下只复用9项非 proof 定位值，标为历史定位；旧迁移/清理两份 proof 不重签、不改时间和摘要，仍待重取。旧11/22和历史窗口均保留原状；新草稿为9/22，缺13个核心输入，另缺实际 release binding。窗口未开、真实范围缺失、当前版本不可核验时维持 BLOCKED。

严格 V2 仍要求 actual observedDeployedCommit=d1a7b811，并增加完整版本/工具证明。要申请应用源等价接收，必须**同时**使用 `--reviewed-equivalence`、输入和 release 的 `mode=REVIEWED_SOURCE_EQUIVALENCE`、经复算的零运行/构建差异，以及另行批准的 review 记录。只有独立源比较或布尔 `approved` 不足；本轮没有真实 review，不启用等价模式。失败不回退为宽松模式。

## 版本证明字段

通用 proof 外层仍采用 `TARGET_CLOUD`、syntheticResponsesAllowed=false、应用 sourceCommit、当前 protocolDigest、runId、账户/区域/栈、inputId、capturedAt 及原审核字段；`sourceCommit` 是候选身份，实际部署 SHA 在 V2 details 中单列。部署和运行两份版本 proof 必须在批准 G4 窗口内观察，且细节版本均为2：

| 记录                         | 要求                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploymentProof.details      | formatVersion、observedDeployedCommit、versions、versionBindingRef。observed SHA 必须等于 input.deployedCommit，不能换写为候选。versions 五主项分别取 api、device-api-handler、ingestion、media-evidence、outbox-publisher 的 CodeSha256                                                                                    |
| versionBindingRef 实体       | formatVersion=2、mode=TARGET_CLOUD、syntheticResponsesAllowed=false、bindingMode、catalogRef、applicationCandidate、repositoryCandidate、executionToolsSourceCommit、observedDeployedCommit、reviewRef（strict 为 null）、preparationWindow、applicationArtifacts、executionTools                                           |
| applicationArtifacts         | 20项精确函数名。每项包含实际 sourceCommit、CodeSha256、configurationHash、revisionId、Active/Successful、artifact。artifact 含实际 CI sourceCommit/安全 CI run 引用、S3 bucket/key、非 null 固定 VersionId、sizeBytes、FULL_OBJECT checksumType；sha256 使用 Lambda CodeSha256 的 Base64 编码，两者一致                     |
| reviewRef 实体               | kind=APPLICATION_SOURCE_EQUIVALENCE_REVIEW、mode=TARGET_REVIEW、syntheticResponsesAllowed=false、decision=ACCEPT_APPLICATION_SOURCE_ONLY、两候选及真实观察 SHA、重算 comparisonDigest、reviewerRef、独立审批记录引用、完整 UTC reviewedAt/expiresAt。只批准应用源码，不覆盖工具、IAM、执行窗口或目标 G4                     |
| executionTools               | 只有 writer、verifier，源码4a99ce1e，实际数字 qualifiedArn、manifestRef、zipRef、publicationRef、networkRef。各自固定 S3 artifact {sourceCommit,ciRunRef,s3Bucket,s3Key,versionId,sizeBytes,checksumType,sha256}；工具 ZIP 的 sha256 为 HEX，读取 ZIP 字节校验，使用 SHA256 Base64 与 Lambda CodeSha256 对照                |
| preparationWindow            | 完整 UTC startsAt/endsAt，最长90分钟及独立 authorizationRef。初始工具发布记录须在该准备窗口内，且两份 manifest 中的窗口和批准引用须精确相同；不是 G4 运行窗口，不能复用已过期授权                                                                                                                                           |
| runtimeVersionsProof.details | 同一 versionBindingRef、同一真实部署 SHA/五版本值、两表名、20项 applicationRuntime（name、codeSha256、configurationHash、revisionId）、20项 authorityWriters（原19+Writer，name、controlTable、payloadTable、configurationHash、codeSha256）、两项 toolRuntime（id、sourceCommit、qualifiedArn、zipSha256、observationRef） |

工具校验子进程重用 MC02 的 ZIP 实体、manifest 与发布验证器，仅消费保存的元数据，不调用 AWS。检查初始发布时刻的 Verifier 五分钟规则；G4 当前元数据还须在 G4 窗口内观察，代码、配置、角色、边界和 runtime 必须与初始记录一致。此复核**不重新授予 Invoke**，不会因已用完的 Verifier 快照自然过期而把独立图像接口验收变成重复验签。需要再次调用 Verifier 时仍按 MC02 新鲜快照流程。工具当前元数据和授权材料未知均保留缺项，不从合成栈/fixture 填造。

V2 receipt 还须绑定同一 versionBinding 头及实际 releaseRef，避免在事后替换候选/版本。未执行模板 releaseRef=null。Hash 检查是文件完整性和声明关联，不能独立认证外部 CI、审批、AWS 事实或调用已实际发生；真实批准和原生证据须单独审阅。任何离线通过最多是输入/收据结构通过，`executionReady=false`、`requiresRealExecutionReview=true`、`G4 NOT_RUN`。旧 FAIL、BLOCKED、NOT_RUN 不被覆盖。

## 下一步

MC04 前置审阅：用冻结清单审阅发布选择、实际目标网络/容量、角色策略增量和观察权限，形成两阶段具体目标写清单及新窗口申请。需要时单独确认精确发布或受审源等价，不将本地文件通过当作授权。未批准前不执行真实云端读取/写入、部署、扩权、迁移、设备启用或 G4 传图。
