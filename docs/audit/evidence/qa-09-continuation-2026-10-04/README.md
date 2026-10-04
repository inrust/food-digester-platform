# QA-09 续验执行账本（2026-10-04）

当前应用候选：`0abf7cf299e0cda1d10ad9c1c1723a1735e3c388`；现有测试账号 `065986019555`、`ap-southeast-1`、`fdp-test-app`。用户要求 KMS/IAM 运维调整由管理员人工处理，本轮执行器不实施策略变更。

## 启动前置与执行来源

- `application-version-preflight.json` / `version-preflight.log`：CI/部署尚未完成的第一次 BLOCKED 回执，永久保留。
- `latest-workflow-state.json`：最新工作流状态，不能替代成功部署或工件字节证明。
- `application-version.json`：同应用提交 CI、自动部署、Amplify、CloudFormation 与19个 Lambda 不可变资产全字节摘要核验；必须 PASS 才可启动云端业务写入。
- `real-wave.json.sources.json`：执行前冻结本地执行器及依赖源码，包含 SHA256 和原字节；`sourceCommit` 标识应用版本，执行器的本地未提交修改以冻结字节为准。

## 范围与判定

真实新前缀双 Customer / 10设备、CSR/mTLS/IoT基线、五角色业务流程、所有已交付写 API 的匿名/角色边界、ESG过期租约恢复、浏览器路由/站点编辑与M-02即时语言切换、HTTP10并发、MQTT quick压缩窗口、20样本Telemetry/API可见及20条在线FORCE_SYNC Command P95。仅对本轮数据执行写入、故障注入与精确清理；保持共享服务和资源策略。

自然生命周期观察在许可证 Issue / Activate 之后立即通过本轮真实设备证书执行 Sync，并用管理 API 回读设备状态。仅归档状态、作用域匹配、签名存在布尔值和请求编号；不存储签名、设备用户密码摘要、Token、私钥或原始 Sync 快照。快照成功交付与实际推进 Assigned→Licensed 分开判定；没有固件许可证验签确认协议及执行证据时，Licensed→Active 不可记为 PASS。本轮不预置 Active 状态。现有FORCE_SYNC门控允许Assigned且持有效REMOTE_CONTROL许可证的在线设备；SLO复测因此可独立执行。挂起/恢复/退役依赖自然Active前置，本轮性能执行器跳过这些操作并显式标记，不能替代自然生命周期验收。

写 API 边界探针使用非法请求体/不存在的对象及冲突版本，仅证明身份、拒绝角色和前置校验，不能替代所有合法写分支。M-02只覆盖站点页与打开详情，不代表117项全业务语义。quick MQTT 含24小时历史消息时间范围，不代表24小时连续运行。队列提交成功也不能替代消费级关联证明。

业务、设备、原文S3及License域归档全部清理并独立核验后才允许声明相应限定子Gate。整套QA-09必须按任务清单补齐所有适用正式回执；本执行器始终输出 `fullQa09Accepted=false`，不能单凭进程退出0或一个限定子Gate解除完整验收缺口。

## 命令

```sh
export PATH=/Users/anray/.nvm/versions/node/v24.12.0/bin:$PATH
export QA09_EXPECTED_COMMIT=0abf7cf299e0cda1d10ad9c1c1723a1735e3c388
export QA09_DEPLOY_RUN_ID=37198390662
node --import tsx scripts/run-qa09-continuation-wave.mjs \
  docs/audit/evidence/qa-09-continuation-2026-10-04/real-wave.json \
  docs/audit/evidence/qa-09-continuation-2026-10-04/application-version.json
```

GH私有仓库只读使用本机既有 `inrust` 登录令牌的内存环境引用，不输出或归档令牌，不改变全局登录账号。AWS凭据和设备密钥仅使用内存引用。

## 本地前置

`targeted-tests.log`：8/8 PASS；`script-tests-final.log`：460/460 PASS；`lint.log`：PASS。完整实时结果与清理证据以本目录最终机器回执及审计报告为准。


## 最终回执入口

- 主轮业务：`real-wave.json.business.json`；自然生命周期：`real-wave.json.natural-lifecycle.json`。原始FAIL保留。
- MQTT精确恢复：`recovery-observe.json`（950原始唯一PROCESSED）；`recovered-archive-3.json`（920原始Telemetry、Outbox原文及canonical payload、五分钟期限逐条核验）。先前归档失败保留。
- 五角色真实签名身份：`signed-session-target.json`（62请求/115断言，安全停用、合法角色和作用域变更；保留五条DISABLED业务墓碑）。
- 独立正常窗口：`normal-slo.json.slo.json`（Telemetry7635ms FAIL / Command2017ms PASS）；`normal-slo-diagnostic-join.json`（逐消息与API轮询、分钟指标关联，有事务提交前时间限制）。
- 正常窗口清理恢复：`normal-recovered-closure.json` 与其 `.domain-cleanup.json` PASS，原父/子超时失败不改写；原SUCCEEDED Build及日志帧分别归档。
- 末次版本：`application-runtime-version-final.json` 的applicationVersionGate PASS，runtime-only顶层PARTIAL保留；`final-lambda-byte-binding.json` 将19个当前Lambda代码摘要/Revision绑定到已验证字节，PASS。`version-final.log` 的首次CloudFormation读取失败保留。
- `formal-target-gates.json`：8套完整领域回执Gate均失败关闭，局部场景不替代正式验收。
- `full-evidence-secret-scan.json`：不限文件大小并解码Base64/gzip的敏感扫描；`repository-secrets.log` 为仓库扫描；最终文件摘要见 `files.sha256`。

补充可重跑入口（必须新夹具；不要复用已清理的证书/密钥）：

```sh
node --import tsx scripts/run-qa09-signed-session-target.mjs <身份专项输出> <已验证版本回执>
node --import tsx scripts/run-qa09-normal-slo-target.mjs <正常窗口输出> <已验证版本回执>
node --import tsx scripts/run-qa09-normal-closure-recovery.mjs <已结束父回执> <已结束正常探针回执> <恢复输出>
```

恢复执行器从同目录绑定原日志/准备计划/Build ID，不接受仅凭进程返回值补造成功。本轮主恢复4/5/6的失败、7的受控中断、8首次语法失败日志均保留；最终成功恢复另存，历史不覆写。


最终汇总 `acceptance-summary.json`：PARTIAL/fullQa09Accepted=false。主轮 `recovered-closure-8.json` 57断言、34清理账本PASS及域清理PASS；正常窗口恢复54断言与域清理PASS。主轮独立audit-empty确认原设备2/证书3摘要一致；最终runtime与不可变资产关联见 `application-runtime-final-byte-binding.json`。`normal-queue-claim-correction.json` 明确否决原错误重投观察标签。源码/文档清单见 `change-inventory.json`；全文扫描可重放：`python3 docs/audit/evidence/qa-09-continuation-2026-10-04/secret-scan-executor.py`。
