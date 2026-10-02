# QA-09 CA 根链字段 AWS 内修复与真实重跑

本操作只用于已授权的现有测试账号 065986019555、ap-southeast-1。依据[字段处置方案](../audit/QA-09-CA根链字段补齐处置方案-2026-10-02.md)及已确认的[精确权限方案](../audit/QA-09-CA根链写权限精确补充方案-2026-10-02.md)。不作为常规应用部署或永久 IAM 变更。

## 运行准备

使用 Node 24.12 和已登录 esgiot-infra / esgiot-readonly 的 AWS SSO。业务身份由十设备执行器临时创建，DB 通过既有专用 CodeBuild 项目核验。不要设置本机 CA 私钥、Secret 值、业务管理员密码或长期 AWS Key。

固定基线 AWSCURRENT 为 c10bbb97-033c-4758-9bcb-e75bb6bd5fa9；ServiceBoundary 默认版本 v3；公开 truststore 固定 VersionId FtN.3H5AydTqt6cgxf0wzeOcNQHFxCOx。任何漂移先停，不能重用旧基线强行写入。固定授权到期 UTC 2026-10-03T00:00:00Z，不自动延期。

必须先等最新受验提交的 CI、Deploy test API、Amplify 均成功、Stack 稳定。`collect-qa09-application-version.mjs` 中提交及运行 ID 应绑定受验版本；历史已验证工件仅在新一轮 AWS CodeSha256、CloudFormation S3 位置重新一致时复用字节验证，不把历史部署当当前版本。

## 顺序与证据

先收集应用版本（输出为本轮独立路径；若使用 --retry-unverified，将历史已验证工件报告复制到该新路径作为复用输入，原报告不修改）：

```sh
node scripts/collect-qa09-application-version.mjs <version-receipt.json> --retry-unverified
```

部署编排器自带预检、精确权限检查、AWS 内一次性函数调用、实际 Worker 受控刷新、十设备执行和 finally 权限清理：

```sh
node scripts/run-qa09-ca-root-repair.mjs <repair-receipt.json> <version-receipt.json> <ten-device-receipt.json>
```

真实 Secret 只在 AWS Lambda 内存流经 Secrets Manager SDK。公开 truststore 和源代码可进入临时 ZIP，私钥和 Secret 值不可进入工作站、环境变量、日志或工件。handler 固定 Secret ARN、KMS Key、根指纹、truststore hash 与到期时间；执行器固定代码 ZIP hash 和函数版本 1。候选 ClientRequestToken 唯一；遇到未知写入结果按原 Token 回读，不能新建另一个 Token 重试。

编排器仅返回布尔值、版本元数据、固定错误码及脱敏业务报告。先独立验证根链修复，再验证真实业务链路：

```sh
node scripts/check-qa09-ca-root-repair.mjs <repair-receipt.json> <repair-gate.json>
node scripts/check-qa09-ten-device-acceptance.mjs <ten-device-receipt.json> <ten-device-gate.json>
```

即使十设备失败，根链子 Gate 可独立 PASS；整体报告保留真实失败，禁止将修复成功等同完整 QA-09。十设备 PASS 仍仅覆盖 CSR/mTLS/IoT/Heartbeat/Telemetry/S3 窄范围，其他 QA-09 验收项按已有矩阵保留。

## 恢复及故障处理

编排器 finally 条件恢复 Worker Description，代码、环境、角色、VPC 等绑定不变；删除本轮函数；撤销 QA09CaRootRepair；仅在默认版本是自己的临时版本或原 v3 时恢复 v3，验证原文不变后删除临时版本；核验原 Worker 默认策略和绑定的 Boundary ARN 不变。原 Secret 版本保留 AWSPREVIOUS，不删除 Secret 或版本。

若调用或清理中断，以实际 AWS 元数据及本轮账本核实，不盲重跑已经成功的修复。尤其当前版本已是候选时，不能再次按旧 baseline 写入。并发漂移时禁止覆盖其他版本、函数配置或权限。必须人工审阅未决清理项，并继续精确清理；未确认清理不得给 PASS。

新十设备验收使用新随机前缀，仅清理本轮设备、证书、请求、消息、Customer、测试身份。闭环独立 DB 审计仍需完整 requestLedger，并比对原设备及证书摘要，不能以 API soft-delete 代替 DB 清理证据。

## 成功推进后的只读恢复

Secrets Manager 的 Stage 元数据可能暂时落后于成功的 UpdateSecretVersionStage。执行核心为新推进提供有界等待，不根据一次旧读断言服务拒绝。若实际已推进，先核实 CloudTrail 成功事件、AWSCURRENT=原候选及AWSPREVIOUS=基线，保留首轮失败回执，不新建候选Token或再次写Secret。

恢复运行增加第4个参数为首轮执行回执：

```sh
node scripts/run-qa09-ca-root-repair.mjs <recovery-receipt.json> <version-receipt.json> <ten-device-receipt.json> <first-attempt-receipt.json>
```

此模式复用原候选Token，仅临时添加此前获准的QA09DeviceCaDecrypt（原SHA256与到期时间固定），不创建边界版本、不授予Secret写动作。handler只保留get/describe接口，AWS内比较旧/新字段和完整链，验证已存在的新版本后再刷新Worker并重跑。恢复后仍撤销限定解密策略、核验v3未变、删除函数、恢复Worker配置。若元数据并发变动或其他字段不符，失败关闭且不覆盖当前版本。

## 最终执行与受控归档读取

本轮最终闭环见[执行记录](../audit/QA-09-CA根链补齐与十设备真实验收执行记录-2026-10-03.md)。若恢复回执已证明 postCleanupWorkerCaReadable=true，恢复编排器直接使用原 Worker 角色验证，不再添加任何临时 IAM 策略；此分支同样验证旧/新字段、受控刷新、配置恢复和最终读回。不能将旧 IAM 模拟拒绝推断为当前实际仍无法读 CA。

加密归档使用已有 fdp-test-replay-role 的一次性 Lambda 在 AWS 内核验本轮双 Customer、十设备、20 条 Telemetry 的 gzip 与 Outbox 摘要及规范化 payload，输出固定元数据。原 Replay 策略/Boundary 不变，无 IAM 写入、Secret 读取或原 Replay 函数更新。调用必须绑定 nonce、代码摘要、计划摘要和发布版本1，并 finally 删除函数。客户端网络正文与 IoT 归一化后的归档字节不要求相同，必须核验业务语义摘要与归档/RDS原始正文摘要。

夹具 CodeBuild 项目当前单并发：seed/observe/cleanup/独立 audit 必须串行。先等所有构建终态，再启动下一次；无种库存的容量失败用 audit-empty 加必需原数据 baseline 和双 Customer 软删除证明，不虚构 requestLedger。已执行 CSR 的尝试必须用真实请求账本 audit-closed。
