# QA-09 首次 ORM 准备与匹配自然冷对照复验

当前为离线准备，目标 NOT RUN。禁止将历史722ms补填成新增阶段或将离线差值宣称AWS收益。实施证据见[报告](../audit/QA-09-首次ORM准备分段与参数化只读离线候选实施记录-2026-10-07.md)。

## 本地可重现

```sh
FDP_DB_POOL_MAX=1 node --import tsx scripts/qa09-prisma-preparation-diagnostic.mjs /tmp/qa09-orm-fresh-output
pnpm exec vitest run apps/cloud-api/test/admin-account-read-candidate.test.ts packages/database/test/client-preparation.test.ts packages/database/test/observed-pg.test.ts
node --test scripts/qa09-client-split-proof.test.mjs scripts/qa09-matched-cold-inputs.test.mjs
pnpm verify
```

每次使用新输出目录，保留失败。诊断每模式3个独立进程，真实Prisma/受控pg，无AWS访问；仅public查询扩展进入生产路径，compiler/Wasm/inspector仅诊断子进程。检查summary gate PASS、pool数1/max1/峰值租约1、两次checkout/SQL/release、无遗留和预读SQL。

## 目标前置

1. 先补候选的默认关闭 Admin hook 开关、测试环境/pool1/engine guard、工作流明确false/true输入与实际config字段。普通push关闭；只允许ApiFn差异，不增加pool/内存/并发，预算70。
2. 人工通过GitHub Desktop推送完成源码。核对完整40位SHA的CI/部署与19实际ZIP及配置，凭据可续期且夹具可清理。
3. 在新版本默认关闭先复验新增submit/await分段。阶段CLI/分析器新增 `--client-split`，同时传原account/runtime/engine/preconnect/client-preparation严格参数；缺自然冷不得伪造。
4. 生成计划（仅生成文件，不dispatch）：

```sh
node scripts/qa09-matched-cold-inputs.mjs FULL_40_CHARACTER_PUSHED_SHA /tmp/qa09-r0-r1-planned.json
```

## R0→R1 顺序

两组同SHA、engine/preconnect=true，nodejs24.x/x86_64/512MiB/reserved12/pool1，连接预算70；相同ACTIVE账号状态、PlatformSuperAdmin、updateContract及409输入。最大并发6、基线PATCH6、独立PATCH最多12。不缓存账号状态、不强制冷启动、不扩大采样，不使用旧SHA冷回执。

R0 accountReadCandidate=false：新前缀限定业务、自然冷采样、逐请求关联；记录Lambda REPORT Init Duration、submit/await/prepare、首checkout/query、账号hook、Gateway/app/client与TCP/TLS。完成自有清理、GlobalSignOut、AWS独立空集、预算窗口覆盖、19工件/配置无漂移后才启动R1=true。R1同流程及清理；最终候选false、preconnect=false恢复，核对实际配置/19工件。缺任何物理冷组保留NOT_OBSERVED，不重放补样。

## 回执绑定与判定

每单位本地manifest包含 `inputs`（计划中本组字段）及 `receipts`；每引用为 `{path,sha256}`，路径只能在manifest目录真实路径内。十个必需引用：version、deployment、config、concurrency、unit、empty、budget、child、patch、audit。保存原始回执并由真实collector产出，禁止手填PASS。

version：同SHA/19 lambdaArtifacts匹配及实际ZIP哈希；deployment：同SHA/runId/Gate；config：实际accountReadCandidate、pool、memory、engineCpu、preconnect、envName、runtime、architecture；concurrency：实际ReservedConcurrentExecutions。unit：闭合清理/内部bindings；child：完整本轮业务/清理；patch/audit：来源child字节及逐请求CloudWatch证明；budget：70上限/窗口覆盖。字段沿用本仓库目标复验回执规范，加载器不迁就旧版缺字段。

```sh
node scripts/qa09-matched-cold-inputs.mjs --pair /tmp/R0/manifest.json /tmp/R1/manifest.json /tmp/qa09-matched.json
```

模板/声明通过仅INPUT_COMPATIBLE，不是目标验收。加载器复核字节、严格阶段、自然物理冷及同SHA/19工件；还需独立审阅真实角色/状态/自然冷策略、仅ApiFn变更和最终恢复回执。匹配少量自然冷只支持逐请求窗口对照，不证明P95或因果收益。INVITED条件激活仍使用ORM，首次模型成本可能推迟到后续操作；须继续保留状态竞争、审计回滚与五角色矩阵。

TCP/TLS保持独立无登录探针、正常证书验证及有界预算，不重复业务夹具。暂无另一授权网络时封存本机Node/curl回执，网络节点归因保留未决。
