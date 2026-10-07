# QA-09 Admin hook 与 C0/C1 复验手册

2026-10-07。本轮仅实现默认关闭接线、离线组合测试、部署输入和阶段 Gate，未开展部署或 AWS 业务运行。前置为[单pool离线所有权验证](../audit/QA-09-默认关闭单pool候选离线所有权与失败矩阵-2026-10-07.md)。

## 接线与安全语义

仅 Admin Lambda 可以读取 `FDP_QA09_AUTHENTICATED_PRECONNECT`，缺省/false关闭；非法值拒绝，true必须同时满足 ENV_NAME=test、FDP_DB_POOL_MAX=1、FDP_QA09_ENGINE_CPU_DIAGNOSIS=true。Infra context `enableQa09AuthenticatedPreconnect` 同样要求test、capacity及engine，只有ApiFn获得此变量。512MiB、并发12、pool1及原5000/10000ms超时不变，无新增SQL、服务或IAM/KMS。

runtime构造时只选一个client；C0使用原factory和公开engine准备，C1使用同pool候选。Router在签名JWT和JSON解析后调用同一个 `createAdminAuthenticatedAccountHook`：先await准备，再逐请求执行原账号查询和INVITED条件激活/审计事务。缓存仅用于准备，不能缓存账号状态。缺失账号仍保持原无写入行为（本hook原本不bootstrap），其他bootstrap路径未改动。准备失败不得执行账号查询或路由；连接此后丢失走原错误路径，不重试业务SQL。

组合测试中的状态/条件更新/审计/回滚均由应用全量迁移后的真实PGlite执行；C1 checkout端口受控模拟，不代表真实pg网络。另以真实生成Prisma/PrismaPg和受控driver验证同pool+实际router/hook顺序，负JWT/非法JSONcheckout=0。不能将离线SQL语义和driver测试合并成AWS连接验收。

## 可重复部署输入（后续执行）

只在人工GitHub Desktop推送后使用同一个完整40位SHA：

| 单元 | expected_commit | engine_cpu_diagnosis | authenticated_preconnect | rollout_phase |
| --- | --- | --- | --- | --- |
| C0 | 同一完整SHA | true | false | 当前固定immediate（或两组均capacity） |
| C1 | 同一完整SHA | true | true | 与C0相同 |
| 收尾恢复 | 同一完整SHA | true | false | 与C0相同 |

普通push由resolver固定preconnect=false，不接受仓库变量/手动输入绕过；手动输入经环境参数传递，不插入shell。每轮expected SHA必须等于workflow SHA，phase必须等于仓库当前phase；非法值、engine=false配C1、SHA/配置/context/重复run漂移均失败。每轮保留Actions input artifact及source/config/refs哈希。

```sh
node scripts/record-qa09-deployment-inputs.mjs --preconnect-pair C0-inputs.json C1-inputs.json input-pair.json
```

此Gate只证明输入可比，不证明已部署、目标版本、业务、清理或P95。先C0：同SHA CI/Deploy、19实际ZIP与ApiFn实际flag=false及预算核对；新前缀有限业务/自然冷采样/逐请求关联；完整自有夹具清理和AWS内独立audit-empty。全部完成后才C1，重新核对19工件/实际flag=true、预算和实际连接峰值≤70。静态63≤70不能替代峰值核验。C1清理后恢复false并核对同SHA实际配置。没有回执不进入下一单元；不得重启共享Lambda制造冷、不扩批、不修改权限或容量。

## 严格阶段 Gate

C0/C1均固定engine=true并使用旧账号/client/engine/runtime严格证明。C1额外加 `--authenticated-preconnect`：

```sh
node scripts/check-qa09-contract-phases.mjs child.json patch-correlation.json audit-correlation.json phases.json --account-phases --client-preparation --engine-cpu --runtime-assembly --require-cold-conflict --authenticated-preconnect
node scripts/analyze-qa09-account-phases.mjs child.json patch-correlation.json audit-correlation.json analysis.json --client-preparation --engine-cpu --runtime-assembly --authenticated-preconnect
```

C0删去最后的preconnect标志，其余输入一致。独立采样台账两命令额外加 `--cold-sampling`；必须分别校验，不能混用基线冷409证明。C1每个有engine准备的请求必须有且只有一个成功预连接阶段，OPERATION_SETTLED、includesConnectionWait=true、同lambda/gateway/operation身份；位于account-hook内，认证完成后开始，两路完成后才account-query。后续db-first-query包含自己的db-first-connection，不能用预连接冒充业务checkout。C0出现预连接即失败；暖态没有新准备阶段时输出null，不编造0ms或冷证明。缺阶段/重复/失败/外请求/非法时间/非法duration/错边界/查询抢跑/越界均失败。

既有精确平台REPORT、物理冷409和child字节绑定要求不放宽。新checker与analyzer记录预连接proof源码hash，父/业务工具增加hook、controller、runtime源码绑定。分析仅增预连接独立耗时，不将engine/preconnect与外层hook相加。收益需对比client/Gateway/REPORT/应用总量及业务/资源，缺冷保留NOT_OBSERVED；输入或阶段PASS不能声明P95、清理或完整QA-09通过。

## 离线命令

```sh
pnpm exec vitest run apps/cloud-api/test/admin-account-hook-combination.test.ts apps/cloud-api/test/admin-engine-diagnostic.test.ts apps/cloud-api/test/admin-runtime-initialization.test.ts apps/cloud-api/test/admin-preconnect-candidate.test.ts packages/database/test/authenticated-preconnect.test.ts
node --test scripts/qa09-authenticated-preconnect-proof.test.mjs scripts/qa09-deployment-inputs.test.mjs scripts/qa09-contract-phases.test.mjs scripts/qa09-rollout-phase.test.mjs
pnpm verify
```

完整verify中的本机HTTP/browser服务需要允许127.0.0.1监听。报告仅按实际命令退出码及证据判定，不用旧/tmp Gate代替本轮输出。

## 2026-10-07执行补充

8b3babb默认关闭/19工件及C0已闭合；C1手动运行在部署前CI阻断，AWS步骤均SKIPPED，实际候选保持false、无C1业务夹具。详见[目标与CI修复报告](../audit/QA-09-8b3babb默认关闭与C0-C1目标复验-2026-10-07.md)。resolver在pnpm verify之前经GITHUB_ENV导出C1输入，读取process.env的基线测试必须显式固定候选false，C1专项显式true，不能继承部署模式来选择mock factory。已完成该测试隔离修复与完整C1环境本地验证，待人工推送新提交。

新SHA必须重新取得相同SHA的C0/C1手动输入及目标回执；旧8b3babb C0不得与新SHA C1混配。C1未实际部署时，核对实际false及19配置并记录无需回退，不能编造C1后恢复回执。

## 2026-10-07 aa9b50e 续跑边界

`aa9b50eb010e2a1735084be587613431e6664ed3` 的 C0 手动运行 `37599096732` 已完成限定业务、精确关联和全部自有清理/独立空集，闭合 PASS。自然冷 409 基线/独立采样均 0，严格冷检查原始非零及 NOT_OBSERVED 保留；不能据此标为冷 409 / P95 通过。C1 `37604997679` 同 SHA 候选 true 的完整验证、部署、实际输入/配置及 19 工件配对均 PASS，但业务前被 SSO 续期 Gate 阻断，无 C1 身份或夹具。共享登录到期与仍有效缓存角色凭据是不同状态；不得把此事描述为 CI 失败。

同 SHA false 恢复运行 `37608794719` 已 SUCCESS，实际 false / test / pool1 / 512MiB / reserved12、19 工件及仅 ApiFn 变更核验 PASS；恢复 Gate 见[本轮报告](../audit/QA-09-aa9b50e默认关闭与C0-C1目标复验-2026-10-07.md)及实际配置/19 工件回执为准。

续跑先执行 `aws sso login --profile esgiot-infra`，核验 profile 绑定的登录到期、账号及角色到期元数据，不记录 Token/密钥。若远程 main 仍为完整 aa9b50e，可在新的证据目录逐字节引用已闭合同 SHA C0，核对 false 恢复、当前 19 工件、预算和未清理资源，再手动 C1、新前缀业务、精确阶段关联、清理/独立空集及 false 恢复；不得覆盖本轮业务前阻断、失败和已封存回执。C1 必须从初始或业务关联请求观察到至少一次合法的真实预连接双路结算，仅 warm 缺阶段为 null 不足以证明候选执行。

本轮本地审计提交与目标应用 SHA 分开记录。建议先完成当前远程 aa9b50e 的 C1，再由人工推送审计提交；若人工先推送新 SHA，必须按新 SHA 重建 C0→C1，不混配 aa9b50e C0 与新 SHA C1。

## 2026-10-07 aa9b50e C1 续跑闭合

SSO 刷新后，远程仍为 aa9b50e，逐字节复用已闭合 C0，先核验当前 false/19 工件/旧前缀空集及 70 连接预算，再执行新的 C1 37613047761。入口分别检查有效登录至少余 10 分钟、infra 缓存角色至少余 75 分钟，给业务及异常清理留余量；不落盘凭据，不将该 Gate 视为未来持续可续期保证。固定 Worker 必须顺序运行，避免账户 Build 并发限制。

C1 新前缀 qa09-cb1f8ce5b43b3b65 的 123 检查、55 精确阶段关联、自有清理与独立空集、末段 19 配置及连接预算 PASS；首次和业务请求共观察到 2 次真实预连接。基线自然冷 409 观察到 1 次且严格证明 PASS，独立采样 0 NOT_OBSERVED，保留严格非零回执。C0 无匹配冷 409，因此对照仅描述性 PARTIAL，不能批准默认开启或 P95。预连接 901ms/业务 checkout0ms 后仍有首次 ORM 准备722ms，下一任务拆分该边界（含编译/规划和调度）；TCP/TLS 暖请求长尾独立记录，不混入冷初始化。

C1 全部清理和阶段闭合后才恢复同 SHA false，运行37619921827及实际preconnect=false/engine=true/19工件PASS，仅ApiFn变化，预算不变。详见[续跑报告](../audit/QA-09-aa9b50e-C1续跑与候选拓扑目标复验-2026-10-07.md)。旧失败及只读重试完整保留；不得用日志读取恢复重发业务。下一轮应用SHA变化需重建同SHA C0/C1；本地审计提交与目标应用aa9b50e分开记录。
