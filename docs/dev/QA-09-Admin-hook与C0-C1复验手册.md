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
