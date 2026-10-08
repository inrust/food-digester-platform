# QA-09 首次 ORM 准备与匹配自然冷对照复验

2026-10-08已补默认关闭候选hook、部署输入/实际配置闭环，本地验证见[接线报告](../audit/QA-09-默认关闭账号读取候选hook与部署闭环-2026-10-08.md)。新代码尚待人工推送及目标同SHA核验，目标 NOT RUN。禁止将历史722ms补填成新增阶段或将离线差值宣称AWS收益。实施证据见[报告](../audit/QA-09-首次ORM准备分段与参数化只读离线候选实施记录-2026-10-07.md)。

## 本地可重现

```sh
FDP_DB_POOL_MAX=1 node --import tsx scripts/qa09-prisma-preparation-diagnostic.mjs /tmp/qa09-orm-fresh-output
pnpm exec vitest run apps/cloud-api/test/admin-account-read-candidate.test.ts packages/database/test/client-preparation.test.ts packages/database/test/observed-pg.test.ts
node --test scripts/qa09-client-split-proof.test.mjs scripts/qa09-matched-cold-inputs.test.mjs
pnpm verify
```

每次使用新输出目录，保留失败。诊断每模式3个独立进程，真实Prisma/受控pg，无AWS访问；仅public查询扩展进入生产路径，compiler/Wasm/inspector仅诊断子进程。检查summary gate PASS、pool数1/max1/峰值租约1、两次checkout/SQL/release、无遗留和预读SQL。

## 目标前置

1. 接线已完成：`FDP_QA09_ACCOUNT_READ_CANDIDATE` 默认false，true需test/pool1/engine/preconnect；部署context `enableQa09AccountReadCandidate` 和手动 `account_read_candidate` 输入受同样guard，普通push强制false。仅ApiFn环境字段，不增加pool/内存/并发，预算70。
2. 人工通过GitHub Desktop推送完成源码。核对完整40位SHA的CI/部署与19实际ZIP及配置，凭据可续期且夹具可清理。
3. 在新版本默认关闭先复验新增observer-setup/submit/await分段。阶段CLI/分析器新增 `--client-split`，同时传原account/runtime/engine/preconnect/client-preparation严格参数；缺自然冷不得伪造。
4. 生成计划（仅生成文件，不dispatch）：

```sh
node scripts/qa09-matched-cold-inputs.mjs FULL_40_CHARACTER_PUSHED_SHA /tmp/qa09-r0-r1-planned.json
```

## R0→R1 顺序

两组同SHA、engine/preconnect=true，nodejs24.x/arm64/512MiB/reserved12/pool1，连接预算70；相同ACTIVE账号状态、PlatformSuperAdmin、updateContract及409输入。最大并发6、基线PATCH6、独立PATCH最多12。不缓存账号状态、不强制冷启动、不扩大采样，不使用旧SHA冷回执。

R0 accountReadCandidate=false：新前缀限定业务、自然冷采样、逐请求关联；记录Lambda REPORT Init Duration、submit/await/prepare、首checkout/query、账号hook、Gateway/app/client与TCP/TLS。完成自有清理、GlobalSignOut、AWS独立空集、预算窗口覆盖、19工件/配置无漂移后才启动R1=true。R1同流程及清理；最终候选false、preconnect=false恢复，核对实际配置/19工件。缺任何物理冷组保留NOT_OBSERVED，不重放补样。

## 回执绑定与判定

每单位本地manifest包含 `inputs`（计划中本组字段）及 `receipts`；每引用为 `{path,sha256}`，路径只能在manifest目录真实路径内。十个必需引用：version、deployment、config、concurrency、unit、empty、budget、child、patch、audit。保存原始回执并由真实collector产出，禁止手填PASS。

version：同SHA/19 lambdaArtifacts匹配及实际ZIP哈希；deployment：同SHA/runId/Gate；config：实际accountReadCandidate、pool、memory、engineCpu、preconnect、envName、runtime、architecture；concurrency：实际ReservedConcurrentExecutions。unit：闭合清理/内部bindings；child：完整本轮业务/清理；patch/audit：来源child字节及逐请求CloudWatch证明；budget：70上限/窗口覆盖。字段沿用本仓库目标复验回执规范，加载器不迁就旧版缺字段。

```sh
node scripts/qa09-matched-cold-inputs.mjs --pair /tmp/R0/manifest.json /tmp/R1/manifest.json /tmp/qa09-matched.json
```

模板/声明通过仅INPUT_COMPATIBLE，不是目标验收。加载器复核字节、严格阶段、自然物理冷及同SHA/19工件；还需独立审阅真实角色/状态/自然冷策略、仅ApiFn变更和最终恢复回执。匹配少量自然冷只支持逐请求窗口对照，不证明P95或因果收益。INVITED条件激活仍使用ORM，首次模型成本可能推迟到后续操作；须继续保留状态竞争、审计回滚与五角色矩阵。

TCP/TLS保持独立无登录探针、正常证书验证及有界预算，不重复业务夹具。暂无另一授权网络时封存本机Node/curl回执，网络节点归因保留未决。

## 2026-10-08 部署和实际配置命令

新完整SHA人工推送后，先核对CI、普通push默认关闭部署和19工件。手动workflow输入使用环境API传递，不拼接到shell：

```sh
gh workflow run deploy-test.yml --ref main -f expected_commit=FULL_40_CHARACTER_PUSHED_SHA -f engine_cpu_diagnosis=true -f authenticated_preconnect=true -f account_read_candidate=false -f rollout_phase=immediate
```

R0 SUCCESS后下载该run/attempt的qa09-deployment-inputs artifact，采集同SHA19工件及最新revision，再采实际预算/config：

```sh
QA09_EXPECTED_COMMIT=FULL_40_CHARACTER_PUSHED_SHA QA09_DEPLOY_RUN_ID=R0_RUN_ID node scripts/collect-qa09-application-version.mjs /tmp/R0/application-version.json
node scripts/qa09-account-read-config.mjs /tmp/R0/qa09-deployment-inputs.json /tmp/R0/application-version.json /tmp/R0/actual-config.json
```

actual-config只读精确fdp-test-api，保存允许列表字段（无完整env/Secret值），与最新19工件中ApiFn revision/code核对。matched manifest的config和concurrency都可引用同一actual-config文件，加载器取其config/concurrency，不删除原始封存数据。

R0限定业务、阶段检查、独立空集与预算闭合后才能启动R1，命令同上仅 `account_read_candidate=true`。两个实际input artifact的比较：

```sh
node scripts/record-qa09-deployment-inputs.mjs --account-read-pair /tmp/R0/qa09-deployment-inputs.json /tmp/R1/qa09-deployment-inputs.json /tmp/account-read-input-pair.json
```

此PASS仅部署输入可比。每组必须有自然冷物理REPORT和 `--client-split` 严格阶段，match loader与实际业务检查不可省略。旧工件可复用已验证ZIP字节，必须新读19配置并绑定新run，不得复用旧ApiFn revision/config。

R1完成/异常后先清理本轮夹具再恢复，恢复手动输入固定 `engine_cpu_diagnosis=true authenticated_preconnect=false account_read_candidate=false rollout_phase=immediate`（同完整SHA）。等待SUCCESS、再核对最新19工件和两flag实际false、仅ApiFn变化、预算/独立空集。无IAM/KMS/资源容量调整，不强制冷、不重复故障注入补样。

2026-10-08目标预检纠正：此前离线输入误写x86_64；de4c2f6的Infra固定ARM_64，真实ApiFn确认arm64。仅修正本机验收输入/只读门禁及负例，未改应用、工作流、架构、内存或并发。目标两组继续绑定de4c2f6；原失败配置回执和首版输入保留。

2026-10-08 客户端分段修复：新版本必须含 `db-client-observer-setup`，与 submit、await-dispatch 共用相邻墙钟/单调边界；CLI仍限定5ms覆盖误差。旧版本三阶段不能升级为新证明。setup结束日志成本归入submit，submit结束日志成本归入await；driver入口最终快照/完成日志位于公开准备边界之后，仍包含在应用总耗时中，不冒充compiler或网络时间。严格Gate通过且自有清理/预算闭合后才派发R1；失败则只执行同SHA两个候选false恢复。详见[实施记录](../audit/QA-09-客户端分段共享边界实施记录-2026-10-08.md)。
