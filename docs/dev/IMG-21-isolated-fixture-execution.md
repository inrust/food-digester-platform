# IMG-21 已批准隔离准备执行与阻塞记录

2026-11-08。基于干净 main `d69f4cc3`，执行用户已批准的 fdp-test-app W01～W07 准备范围。应用候选仍为 `d1a7b81196d60ec320e760da3d18de403563fc12`，G3证据提交1b1b879f，协议摘要仍为 `59aa04f04df4a9b6b0cb5c76af407541b0bf5bc7b808887b7be9e8f5e2e6ee70`。

**已独立完成 W06 原生只读核验；完整隔离准备仍为 PARTIAL/BLOCKED，设备预览尚未启用，G4=NOT_RUN。** 没有部署、迁移、扩权、创建用户/客户/设备/证书、写白名单或执行真实G4传图。不等待第三方App或真机。

## 授权、窗口及实际写入

用户已批准此前精确W01～W07范围，并明确“不部署、不迁移、不扩权、不运行真实G4传图”。原[d69f4cc3申请](../audit/evidence/2026-11-08-device-image-fixture-preparation/write-approval-request.json)作为不可变历史保留；本轮[批准与准备窗口](../audit/evidence/2026-11-08-device-image-fixture-execution/approved-preparation-window.json)记录当前用户授权，原申请文件不改写。

W06独立前置通过后，于北京时间 **20:41:58** 启动90分钟准备窗口，截止 **22:11:58**（UTC 12:41:58.802738～14:11:58.802738）。其他分支的执行入口前提未满足，不能因范围获批就绕过它们。该窗口只授权准备，不是G4接口传图窗口，不填作允许CF01～CF03写入的executionWindowProof。

唯一实际控制面写操作为一次 `codebuild:StartBuild`：

- 项目：fdp-test-qa09-readonly-runner。
- BuildId：`fdp-test-qa09-readonly-runner:1686d06a-7776-4701-b1e9-7b2213cb4fd5`，结果SUCCEEDED。
- 使用已批准请求Hash `98747c1bcf79d31437ae963bdb7d8a4f011b62ee1765a0d0f33fc27cc8ad13ee`，固定buildspec Hash `b41dedd4c6d763dd903f38511df61f16f33041dd21190cc1e127630ec7b55513`，只覆盖本次buildspec和manifest/探针Hash。
- 调用前落盘attempt与幂等键；取得已知BuildId后只轮询/收集，不重启或盲重试。云端未知写结果为0。
- 独立后置确认项目默认buildspec、serviceRole和VPC未变；原默认buildspec漂移89223882…与预期b3c47e21…仍保留历史BLOCKED，不把一次覆盖说成项目默认源码已修好。

## 真实核验结果

[数据库验证](../audit/evidence/2026-11-08-device-image-fixture-execution/database-verification.json)绑定实际BuildId、批准源码、角色/VPC、原生快照和准备时间窗。

| 项目 | 结果与范围 |
|---|---|
| 当前应用元数据 | 20个Lambda代码Hash匹配历史已验证制品；19个数据库权威入口表配置匹配；不等于精确d1候选已部署 |
| 原生PG事务 | read_only=on，businessDataWrites=false，快照北京时间20:43:02 |
| 迁移 | 44项已应用，checksum全部匹配；缺失/不匹配/未完成/额外项均为空 |
| 表 | 61张预期表均存在；这是迁移记录与表存在性核验，不是全量live schema列/索引差异审计 |
| 项目后置 | 单次覆盖未修改现有项目默认源码、角色、VPC；无项目更新/部署 |
| 资源及清理 | 本轮业务资源创建为0；两个计划Cognito用户名后置均ABSENT。无需业务清理，保留Build审计记录和仓库外私钥，不删除既有资源 |

## W01～W07 逐项结论

[执行明细](../audit/evidence/2026-11-08-device-image-fixture-execution/execution-steps.json)保留各项状态。

| 项目 | 状态 | 原因 |
|---|---|---|
| W01 Cognito身份 | NOT_RUN | 没有兼容DB写入口时不先制造无法落库的特权账号/孤儿身份 |
| W02 数据库用户/scope | BLOCKED | 在已核验的20个fdp-test函数和既有作业中，无适合本轮单设备、使用createPreviewAwarePrismaClient的受控入口。旧ten-device-fixtures仅接受qa09/十设备计划，使用裸SQL；first-admin bootstrap要求空用户库，均不可代用 |
| W03 客户/站点/CSR审批/接入 | NOT_RUN | 没有可用的本轮审批actor与客户；未发送Onboarding请求、首Heartbeat或分配请求 |
| W04 License及Active前提 | BLOCKED | IAM GetRole返回NoSuchEntity：fdp-test-qa09-license-verifier-role不存在；本地完整元数据对照检查也确认现有验签器接受旧syncprobe绑定、拒绝本轮img21序列号/型号。未创建角色/扩权、伪造旧前缀、导出HMAC key或手改Active |
| W05 opt-in及白名单 | NOT_RUN | 没有本轮Active设备、当前证书和受控权威写入口；实际启用数为0 |
| W06 原生只读核验 | PASS_NATIVE_READ_ONLY | 批准的单次作业成功，44迁移/61表/只读事务证据齐全 |
| W07 清理 | NOT_REQUIRED | 业务资源/用户/白名单/租约均未创建；无须清理他人资源。Build日志保留为审计，不把空台账当G4清理通过 |

未调用旧fixture脚本的create-project/update-project、临时Lambda部署、裸SQL seed、直接DDB写入或缺失验签角色创建。未借用历史真实用户、设备、证书或Token。私钥仍在仓库外600文件/700目录，仅检查其与原公共CSR的匹配。

## 准入材料推进与剩余缺项

[当前inputs](../audit/evidence/2026-11-08-device-image-fixture-execution/inputs.json)已结构性提供 **11/22**，新增迁移证明和用户已批准的清理计划；[离线准入](../audit/evidence/2026-11-08-device-image-fixture-execution/admission.json)为BLOCKED，错误0、缺项11。

迁移证明是真实准备阶段的目标观察；cleanupPlan仅证明获批计划，无业务资源时没有执行清理。二者均注明PREPARATION_ONLY、g4ExecutionProven=false，真实G4时仍须按其窗口复核。

| 剩余项 | 原因 |
|---|---|
| deployedCommit / deploymentProof / runtimeVersionsProof | 真实运行Hash绑定历史69制品，不能改写为d1已部署；精确候选或经核验的源等价绑定仍未完成，不自动部署 |
| deviceId / customerId | 没有受控入口及可用审批actor，未创建 |
| deviceMtlsRef / mqttIdentityRef / viewerARef | 未创建设备、签发证书或建立Cognito+DB用户；计划引用不冒充可用身份 |
| sequenceReservation | 无真实设备基线，未占用序号 |
| testScopeProof / executionWindowProof | 本批明确排除真实CF01～CF03，且无实际设备/客户ID；90分钟准备授权不能冒充G4范围/窗口授权。这两项是本批有意未开放，不是等待第三方App |

## 检查、FAIL、BLOCKED、NOT_RUN

- 本地执行保护测试12项通过：固定请求Hash、窗口过期/超长/未开始拒绝、准备窗口不得授权G4、未知写结果不重试、AccessDenied单次停止、固定BuildId及实际证据绑定。
- 原生探针/只读前置15项、执行包136项通过；包、源/产物摘要、格式、边界、证据和敏感信息检查通过。未修改业务、契约、IaC或独立协议工具，未重跑全量verify/构建/全仓脚本；其本批NOT_RUN保留，应用G3仍仅引用既有d1候选证据。
- 首轮前置执行身份未验证，原BLOCKED保留。首轮底层失败类别未留存，不能推定原因；独立STS诊断及第二轮完整只读前置均验证现有InfraSetup身份，通过后才启动作业；补充了失败类别记录。
- 默认作业源漂移、缺少受控写入口、缺少/不兼容验签通道及精确候选版本证明均保留BLOCKED；没有为了“通过”新建角色、扩权限或替换设备身份。
- 本轮无未知写结果、无未解决本地FAIL。真实CF01～CF03、身份/设备/证书创建、License确认、白名单启用与G4清理均NOT_RUN。历史失败与本地负例测试不改成目标PASS。

下一任务先解决可复用的受控单设备写入口、授权验签通道及版本证明绑定。当前核验到的入口不满足条件；若必须新增部署或权限，就超出本次明确限制，应另立方案，不能在本轮执行。已批准范围无需重复确认，但超过22:11:58后恢复写入必须有新的有效窗口。真实G4另行安排，仍不依赖App或真机。
