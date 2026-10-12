# QA-09 未知 StartBuild 小批定位与完整对照复验

本轮修复本地只读定位器，不改变应用候选、SQL、连接池、容量或 IAM/KMS。前轮 `ac5c0c3` 的 business-audit 启动响应超时，原 R0 FAIL、原启动 UNKNOWN、R1 NOT RUN 及已闭合清理/关闭恢复均保留原字节；没有匹配、CloudTrail 没有记录均不能证明没有执行。[实施记录](../audit/QA-09-未知StartBuild小批定位实施记录-2026-10-12.md)。

## 固定读取预算及身份边界

| 项目 | 限制 |
| --- | --- |
| 总时限 | 整次调用共享单调时钟90秒，含身份、清单、全部详情批次、等待和最终检查 |
| 单次 CLI | 最多15秒，且不超过剩余总时限；AWS_MAX_ATTEMPTS=1 |
| 清单 | 固定项目、倒序最多50个唯一 ID；只读取这一次清单，不扩窗或追加分页 |
| 详情 | 每批最多5个、串行，50个拆成10批；全部批次完成前不得提前接受唯一匹配 |
| 瞬态恢复 | 全流程合计最多2次，每次等待250ms；各批不能重新获得额度，整次最多14个 CLI 子进程 |
| 完整性 | 每批响应 ID 集必须恰好等于请求集，拒绝重复、缺失、外来及跨批 ID；响应顺序可变 |

输入必须是原 FAIL/START_OUTCOME_UNCONFIRMED 回执及其原 preparation，绑定精确 Plan 字节、源码哈希、buildspec、固定项目、唯一 Worker、VPC 和环境变量。读取使用 `esgiot-readonly`，仅 STS GetCallerIdentity、CodeBuild ListBuildsForProject/BatchGetBuilds，无 StartBuild 或其他写入依赖。

超时或永久错误停止后续读取；已经记录的安全逐调用结果保留，不写原始 stderr、其他 Build 载荷或凭据。新输出绑定两个输入和读取器/执行器 SHA-256，禁止覆盖原输入或已有输出。`readBudget`、批次序号/数量和每次失败、耗时用于独立检查预算；恢复成功仍保留 `originalReadGate=FAIL`。

清单被截断或恰好50条时，最老记录必须覆盖原启动前120秒，否则保持 UNKNOWN。唯一精确 Build 也必须位于原启动前120秒至原结束后30秒；多匹配或超窗则 BLOCKED。零匹配是 UNKNOWN。`RESOLVED` 只定位既有 Build 身份，`executionGate/cleanupGate=NOT_ASSESSED`，原 FAIL/UNKNOWN 不升级，`writes=0`、`restartAllowed=false`、`absenceProvesNonExecution=false`。

```sh
node scripts/read-qa09-unknown-start.mjs <原FAIL回执.json> <全新定位回执.json>
```

只有 RESOLVED 返回0，其余返回1。确切 Build 身份可以交给既有精确结果读取器另存结果；这不允许重启原 Plan、重放业务、改写原回执或替代原流程 Gate。只读容量未知启动也不得自行重新 StartBuild。

## 新 SHA 目标顺序

1. 完成本地验证、提交并正常推送；核对同完整 SHA 的 CI、默认关闭部署、19实际工件、实际配置。候选五开关 false、engine=true；ApiFn512MiB/reserved12/pool1，静态连接预算63≤70不变。旧 SHA 回执不代替新回执。
2. 按[自有边界摘要复验](QA-09-自有边界摘要接线与目标复验.md)建立全新证据目录、R0/R1输入及不同新前缀。冻结 helper、全部 repo 依赖及本轮三个定位器文件；验证历史 manifest/提交绑定。入口要求可续期 SSO 登录至少10分钟余量、角色清理余量至少75分钟、一次唯一容量预检通过。
3. R0：engine/preconnect/account/detail/public=true、observer=false。原始业务并发≤6、6次基线和最多12次独立 PATCH，原父子清理、独立空集、全部阶段及辅助入口 Gate 完整闭合后才能启动 R1。不放宽5ms阈值，不追加样本。
4. R1：仅 observer=true，使用另一新前缀。执行相同原始业务、清理和阶段关联；普通/一次精确恢复均遵守原小批日志读取预算。任何原始失败保留，未完整闭合不得宣布对照通过。
5. R1清理后同 SHA关闭恢复五候选false、engine=true；重新核对19工件/配置、18非API revision、容量/连接预算、两前缀数据库/身份/归档空集、既有设备证书指纹及所有已知精确自有 Build 终态。

任一失败优先完成本轮原清理和关闭恢复。未知 StartBuild 仅按上述有界只读定位，原 Plan 永不重启；不能定位时 UNKNOWN 保留。必要的独立最终空集核验使用另一个只读 Plan，不是原未知 Plan 重启。业务和原阶段 Gate 不因局部定位/清理 PASS 而升级。TCP/TLS 仅分析本轮既有请求，不追加网络探针；节点归因继续未决。独立设备验签、自然 Active 和邀请发送不在本轮补造回执。

## 本地失败矩阵

```sh
node --test scripts/qa09-unknown-start-read.test.mjs
node --test scripts/qa09-cleanup-recovery.test.mjs scripts/qa09-cognito-observation.test.mjs scripts/qa09-fixture-cli-observation.test.mjs
pnpm test:scripts
pnpm verify
```

60项定位器测试覆盖0/1/5/6/12/50条、尾批、串行、晚批歧义及窗口边界、重复/缺失/外来/跨批/非法响应、错误账号、非法预算、总时限及持久化耗时、跨批全局恢复耗尽、永久拒绝/SSO过期、实际 CLI 入口、安全输出、原输入字节不变和禁止覆盖。测试使用虚拟时钟/受控 AWS 替身，不访问 AWS；本地 PASS 不是目标环境验收。
