# af15a08 CI / Lambda 发布门禁超时修复

被诊断提交：`af15a08beb72794b359a7ac0874c8248d9b0961b`。本轮修复状态：**LOCAL_VERIFY_PASS，完整 pnpm verify 退出 0**。验证基线为 af15a08，测量修复后工作树字节，随后提交相同源码；远程新提交验证待人工推送。本轮不推送、不重跑远程作业、不部署。

## 原因与远程证据

该提交的 [CI 37180969096](https://github.com/inrust/food-digester-platform/actions/runs/37180969096) 和 [Deploy test API 37180969166](https://github.com/inrust/food-digester-platform/actions/runs/37180969166) 均因 `pnpm verify` 中 QA-05 的 `parallel-repeat` 失败终止。不是上一轮清单/Viewer 矩阵漂移：串行 35 项已通过；并行阶段运行 70 次、两个 worker，启动了部分执行后被终止，未产出完整浏览器结果。

| 远程作业 | QA-05 串行阶段 | 并行停止处 | 串行输出结束至并行错误 |
| --- | --- | --- | --- |
| CI | 35 passed，约 3.8 分钟 | 已启动 55/70，BROWSER_PHASE_FAILED parallel-repeat | 06:15:33.186Z → 06:19:33.470Z，约 240.28 秒 |
| Deploy test API | 35 passed，约 3.8 分钟 | 已启动 53/70，相同错误 | 06:15:49.460Z → 06:19:49.706Z，约 240.25 秒 |

以上为 2026-10-04 UTC 日志时间，北京时间加 8 小时。默认浏览器首轮也已 35 passed（约 3.9 分钟）。两个作业的安装及浏览器安装步骤成功，工作流本身未到 45/60 分钟 job 超时；部署的 OIDC、账户/SHA、CDK diff/deploy 均 skipped。

根因：[run-admin-e2e.mjs](../../scripts/run-admin-e2e.mjs) 对串行 35 次和并行重复 70 次均固定 `spawnSync timeout: 240000`。慢于本地 macOS 的 GitHub Ubuntu runner 串行已接近上限，并行未完成就耗尽预算。旧执行器把 ETIMEDOUT、非零退出等合并为同一个 BROWSER_PHASE_FAILED，掩盖具体原因。日志没有该阶段的断言错误或完整结束统计；时间边界和固定超时源码共同定位子进程时间预算不足。旧日志未直接打印 ETIMEDOUT，不把事后新增的分类当作当时日志已有字段。

`spawnSync` 缓冲输出，远程进度行的写入时间不代表单个用例开始时间；此处依据相邻阶段输出边界及错误时间定位，不虚构逐用例耗时。上一轮本地完整 PASS 保持历史有效，但不表示 GitHub runner 同样耗时或已成功部署。

## 修复与严格检查

- 总阶段预算按 `120000 + ceil(requiredCases × repeatEach / workers) × 15000` 毫秒计算，最多 900000 毫秒；当前 35 个必需用例的串行及双 worker 重复阶段均为 645000 毫秒。预算包含构建/服务器启动和全部执行，以固定源码策略管理，不允许环境变量跳过或无限放大。
- 不改工作流、worker/repeat 配置、单用例超时或 retries。35 项清单、105 次完整执行、独立权限预期、行为证明、缺项/额外项/重复项/skip/flaky/retry 拒绝、网络阻断、唯一前缀、清理和来源哈希检查保持不变。
- 超时明确报 BROWSER_PHASE_TIMEOUT（含 phase 和 limitMs），其他子进程错误仍报 BROWSER_PHASE_FAILED。任何失败仍写 FAIL 并退出非零；不解析部分报告为 PASS。成功阶段记录 timeoutMs/durationMs，日志记录阶段开始预算和结束耗时。
- 新增预算缩放/上限、非法参数、真实 Node 子进程 ETIMEDOUT、非零退出即使 stdout 为“70 passed”、被终止进程、原始异常不泄露等回归；与既有检查合计 45 项。真正成功的进程仅进入后续严格报告与轨迹校验，不能替代它。

## 验证与交付

定向 45 项测试全部通过；最终完整 `pnpm verify` 退出 0。lint、格式、typecheck、OpenAPI、构建、边界、Schema、迁移、证据、敏感信息、运行时、CDK synth 及 QA-02～08 本地 Gate 均通过。

| 测试 | 最终结果 |
| --- | --- |
| 单元 | 165 文件、1340 项 PASS |
| 契约 / 脚本 | 301 / 434 项 PASS；脚本包含本轮 45 项验收器测试 |
| 默认浏览器回归 | 35 项 PASS |
| QA-05 串行 | 35 次 PASS，timeoutMs=645000，durationMs=83760 |
| QA-05 双 worker 重复 | 70 次 PASS，timeoutMs=645000，durationMs=91399 |
| QA-05 严格验收 | 105 次完整执行，权限/行为/隔离/清理检查通过；187 个来源哈希匹配当前源码 |
| QA-08 | 24 用例、24 快照 PASS；266 个来源哈希匹配 |

归档 [远程诊断摘要](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/remote-diagnosis.json)、[CI 作业元数据](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/ci-run.json)、[部署作业元数据](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/deploy-run.json)、[CI 失败摘录](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/ci-failure-excerpt.txt) 和 [部署失败摘录](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/deploy-failure-excerpt.txt)。原始完整日志保留在本地 /tmp，摘要保存其 SHA-256 和 af15a08 原执行器哈希。

本轮验证证据：[45 项定向结果](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/collector-tests.txt)、[完整验证摘要](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/verify-summary.json)、[成功日志摘录](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/verify-success-excerpt.txt)、[QA-05 回执](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/qa05-receipt.json)、[QA-08 回执](evidence/admin-ui-af15a08-ci-timeout-2026-10-04/qa08-receipt.json)。摘要含最终完整日志、各 QA 回执和两个变更源文件的 SHA-256。提交前核对字节和工作区，提交后再次校验相同字节。

本机为 Node 24.12.0 / pnpm 10.20.0 / OpenSSL 3.5.0 / 无头 Chromium。本轮未执行 Linux 容器验证；本地结果不冒充 GitHub Ubuntu 成功。目标 Cognito/API 与 Lambda 版本仍待新的远程部署成功后核验。

下一步：人工通过 GitHub Desktop 推送本次本地修复，查看新 SHA 的两条流水线最终结果以及 QA-05 阶段预算/耗时；后端部署成功后核验 Lambda 制品与提交绑定，再复验 H-01 旧 Token 读写拒绝及 M-01 Viewer 只读访问。没有真实回执时，目标验收保持 `NOT RUN / NO RECEIPT`。
