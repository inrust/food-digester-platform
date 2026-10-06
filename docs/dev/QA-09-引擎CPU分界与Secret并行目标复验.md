# QA-09 引擎CPU分界与Secret并行目标复验

2026-10-06。承接[预算内优化方案](QA-09-adapter后冷窗口预算内优化方案.md)。CPU分界独立提交893d791；Secret并行与单飞初始化为后续独立提交，便于分别回退。只实施方案第1/2步，不实施初始化期引擎预准备/I/O重叠。必须人工GitHub Desktop推送最终提交后，核对同SHA CI/Deploy/Amplify和19实际ZIP，才启动新前缀业务夹具。

## 配置与阶段所有权

`FDP_QA09_ENGINE_CPU_DIAGNOSIS=true`仅允许ENV_NAME=test、pool1。CDK context `enableQa09EngineCpuDiagnosis`默认关闭且要求测试容量已开启，只向Admin API下发。测试部署工作流在capacity/immediate阶段默认启用，GitHub变量FDP_QA09_ENGINE_CPU_DIAGNOSIS可明确设false关闭；其余阶段默认false。不改512MiB/并发12/pool1及63≤70预算，不加IAM/KMS或其他17个DB函数的诊断调用。

| 阶段 | 边界 |
| --- | --- |
| runtime-database-secret / runtime-license-secret | 同引用的两个Secret读取，可重叠；都嵌套runtime-initialize，不能与顶层重复累计 |
| db-engine-prepare | 有效JWT、正常JSON解析后，admin-account-hook内，账号查询前调用公共$connect；成功一次/现有client；失败不发布成功缓存，保留原错误 |
| db-adapter-connect / db-engine-after-adapter | 引擎准备内部adapter创建及其后缀；后缀以OPERATION_SETTLED收尾，不含业务SQL或checkout |
| admin-account-query | 原业务用户状态模型查询；每请求仍执行，包含首计划/driver/checkout，不能将其全部CPU称作纯编译CPU |
| db-client-prepare / db-first-query / db-first-connection | 查询准备仍以DRIVER_DISPATCH收尾；driver/checkout仍归实际模型查询，不能归引擎准备 |

CPU字段仅非负整数processCpuUserUs/processCpuSystemUs，scope固定PROCESS_ALL_THREADS。它们是区间进程全部线程的user/system累计差，不是JS线程专属、函数采样或逐模型纯编译CPU，后台工作和重叠区间可能重复计入；不得相加当总量。外部SQL/握手等待通常不消耗同量CPU，但仅凭差值也不确定其根因。无CPU profile/SQL/参数/模型Schema/Secret输出。

诊断请求首次authenticated未必等于物理冷：先有401初始化后，第一次真实登录仍可能有engine阶段却coldStart=false。成功准备后warm缺engine/adapter/suffix表示null；模型查询CPU每次都有。无效JWT/匿名不执行引擎准备和账号SQL；DISABLED/INVITED状态检查、授权、审计与原错误保持。零checkout保证以固定Prisma7.9.1/PrismaPg测试为准，升级后必须重测。

Secret并行默认开启；`FDP_ADMIN_PARALLEL_SECRETS=false`恢复顺序解析，非法值在远程工作前失败。所有必需配置和pool设置先验证；两个promise均settle后以DB优先、License次之抛原失败。只在两者成功后构造client和handler，初始化单飞且失败可由下一请求重试。没有业务写入重试。暂不新增CDK并行开关，云端回退首选回退Secret独立提交，保留CPU分界；不得临时手改共享Lambda配置替代同SHA发布。

## 同SHA与真实复验

遵循[客户端准备复验](QA-09-客户端准备阶段与TLS长尾复验.md)的SSO、版本、19 ZIP、新前缀、清理和独立audit-empty流程。启动前还必须以只读命令保存唯一API安全配置，不能导出完整环境变量：

```sh
aws lambda get-function-configuration --function-name fdp-test-api --profile esgiot-readonly --region ap-southeast-1 --query '{revisionId:RevisionId,memory:MemorySize,state:State,update:LastUpdateStatus,envName:Environment.Variables.ENV_NAME,pool:Environment.Variables.FDP_DB_POOL_MAX,engineCpu:Environment.Variables.FDP_QA09_ENGINE_CPU_DIAGNOSIS,parallelSecrets:Environment.Variables.FDP_ADMIN_PARALLEL_SECRETS}' --output json --no-cli-pager
aws lambda get-function-concurrency --function-name fdp-test-api --profile esgiot-readonly --region ap-southeast-1 --output json --no-cli-pager
```

引擎诊断须engineCpu=true/test/pool1/512MiB/并发12；parallelSecrets缺省表示本版本代码默认true，须结合19 ZIP和本提交源码，不能从缺省值证明旧版本并行。末段同样读回revision和预算，与19工件尾段无漂移配对。

版本与执行命令：

```sh
QA09_EXPECTED_COMMIT=<new-full-sha> QA09_DEPLOY_RUN_ID=<new-deploy-run> QA09_CODE_RANGE_TRANSPORT=sdk node scripts/collect-qa09-application-version.mjs <new-dir>/application-version.json
node --import tsx scripts/run-qa09-nonactive-target.mjs <new-dir>/sample.json <new-dir>/application-version.json --cold409-sampling
python3 scripts/collect-qa09-contract-correlation.py <new-dir>/sample.json <new-dir>/baseline-patch.json
python3 scripts/collect-qa09-contract-correlation.py <new-dir>/sample.json <new-dir>/baseline-audit.json --audit-get
node scripts/check-qa09-contract-phases.mjs <new-dir>/sample.json <new-dir>/baseline-patch.json <new-dir>/baseline-audit.json <new-dir>/baseline-phases.json --account-phases --client-preparation --engine-cpu
node scripts/check-qa09-contract-phases.mjs <new-dir>/sample.json <new-dir>/baseline-patch.json <new-dir>/baseline-audit.json <new-dir>/baseline-cold.json --account-phases --client-preparation --engine-cpu --require-cold-conflict
node scripts/analyze-qa09-account-phases.mjs <new-dir>/sample.json <new-dir>/baseline-patch.json <new-dir>/baseline-audit.json <new-dir>/baseline-analysis.json --client-preparation --engine-cpu
python3 scripts/collect-qa09-contract-correlation.py <new-dir>/sample.json <new-dir>/sampling-patch.json --cold-sampling
python3 scripts/collect-qa09-contract-correlation.py <new-dir>/sample.json <new-dir>/sampling-audit.json --cold-sampling --audit-get
node scripts/check-qa09-contract-phases.mjs <new-dir>/sample.json <new-dir>/sampling-patch.json <new-dir>/sampling-audit.json <new-dir>/sampling-phases.json --account-phases --client-preparation --engine-cpu --cold-sampling
node scripts/check-qa09-contract-phases.mjs <new-dir>/sample.json <new-dir>/sampling-patch.json <new-dir>/sampling-audit.json <new-dir>/sampling-cold.json --account-phases --client-preparation --engine-cpu --cold-sampling --require-cold-conflict
node scripts/analyze-qa09-account-phases.mjs <new-dir>/sample.json <new-dir>/sampling-patch.json <new-dir>/sampling-audit.json <new-dir>/sampling-analysis.json --cold-sampling --client-preparation --engine-cpu
```

保留每个stdout/stderr/exit、失败及warm未命中回执；两集合独立Gate。CPU模式必须新增--engine-cpu，并保留--client-preparation；关闭开关仍用旧lazy门禁，不能删旗标宣称新阶段PASS。原三轮冷证明另外严格绑定唯一REPORT/initDuration>0/512MiB；采样Gate内置该要求。未命中保留COLD_CONFLICT_REQUIRED，严格分析NOT_RUN，不扩大预算/重启造冷。需要查询初始化Secret阶段及顶层runtime-initialize，确认两阶段重叠；阶段各自的计时不能相加当收益。

比较端到端client/Gateway/REPORT/应用总量、引擎wall/CPU及账号query CPU；account准备下降只是成本前移。诊断分支与并行Secrets共同上线无法单凭前后一个样本把收益全部归并行；必要时后续以默认关闭诊断的独立SHA对照，不临时改资源或无限采样。六PATCH基线、最多两批共12采样PATCH、每批并发最多6不变。独立TLS使用已提交Node12/curl6探针和另一授权网络证据，与服务端样本不混算P95。

无设备独立HMAC/Active验签、邀请发送或未授权网络操作。完成所有本轮父子/身份/客户站点/归档清理、独立空集与尾段版本；任何清理缺口单独FAIL。完整QA-09/P95不因本地验证或阶段数字改善自动通过。
