# QA-09 ORM提交与pg结算默认关闭观测复验

依据：[前一轮离线分界](../audit/QA-09-ORM驱动离线分界与传输对照-2026-10-08.md)。17fb6f1的R1首次合同读取ORM准备502ms、driver-query132ms没有目标内部边界，不能用新观测追溯拆分。此轮接线只观察原Contract.findFirst公开提交和原pg查询结算；新SHA必须人工推送后重新取得目标证据。

## 默认关闭与边界

新增`FDP_QA09_CONTRACT_LOAD_DETAIL`，仅严格`true`开启。运行时/CDK/发布输入共同要求test、既有容量、pool1、engine=true、authenticated_preconnect=true；仅ApiFn拥有开关，push强制false。静态预算仍63≤70，ApiFn仍nodejs24.x/arm64/512MiB/reserved12，业务并发最多6，不新增SQL、池、重试、缓存、容量或私有compiler钩子。

| 子段 | 原父段 | 公开边界及含义 |
| --- | --- | --- |
| contract-load-orm-submit | orm-prepare | 原模型扩展入口→原query(args)同步返回；含既有准备观察器成本 |
| contract-load-orm-await | orm-prepare | 同步返回→原事务适配器派发；含Prisma惰性准备/调度，非纯compiler |
| contract-load-driver-before-pg | driver-query | 原事务适配器入口→租约内pg.query入口；含适配器准备和观察成本 |
| contract-load-driver-pg | driver-query | pg.query入口→原Promise/回调结算；含队列、网络、服务器、pg处理，非纯服务器时间 |
| contract-load-driver-after-pg | driver-query | pg结算→原适配器结算；含结果映射、微任务与观察成本，非纯解码 |

每个分界复用父段原始单调/墙钟/CPU快照，原四段和新子段覆盖容差保持5ms。CPU为PROCESS_ALL_THREADS，不能累加嵌套CPU或把includesConnectionWait=false解释为纯CPU证明；pg子段的该字段为true。边界捕获/日志成本进入后续子段，最终日志仍进入应用总耗时。R0/R1同时开启相同观测，避免把观测有无当成候选收益。

每次checkout仅在该client上临时包装query/release，释放前恢复原属性描述符；不改pg原型或适配器事务所有权。保留原Promise身份、异常、回调this/参数/返回值，不替换业务回调上下文。只将观察回调绑定原请求。BEGIN/COMMIT/ROLLBACK、账号查询和其他请求不会取得合同pg归属。支持普通字符串/config/values加末尾回调，以及当前Prisma使用的config+Promise；自定义submittable、嵌入回调、不可写端口和非原生Promise直通，缺子段时严格Gate失败，不能推断为零。每条合同读取必须modelEntries=1/driverDispatches=1/transactional=true/detailEnabled=true/pgQueries=1/pgSettlements=1；重复、多查询、错请求、失败、缺结算拒绝证明。

## 同新SHA顺序与固定输入

1. 人工通过GitHub Desktop推送本地实现SHA。核对同完整SHA CI、push默认关闭部署、Amplify，以及19实际ZIP/S3/配置。数据库共享代码有变化，首次新SHA不能复用17fb6f1工件；后续同SHA切换开关才要求仅ApiFn配置变化、19代码和非API revision不变。
2. 创建新输出目录，生成预算内输入（命令如下，不派发部署）。登录及角色余量、受控数据库读取和最终清理通道满足[原手册](QA-09-首次ORM准备与匹配自然冷对照复验.md)后才创建新前缀。
3. 手动Deploy test API，branch=main，expected_commit=完整SHA，rollout_phase=immediate。R0：engine_cpu_diagnosis=true、authenticated_preconnect=true、account_read_candidate=false、**contract_load_detail=true**。核对发布的qa09-deployment-inputs.json及其字节、实际开关、19工件和ApiFn配置再入场。
4. R0执行原限定业务、6条基线PATCH、最多12条独立采样、审计GET与12认证无SQL负向；每请求HTTP→Gateway→Lambda→REPORT精确关联、原客户端/四段及新五段严格Gate、预算采样、自有清理/GlobalSignOut/独立空集与原设备证书指纹闭合。严格阶段失败只清理并恢复，不放宽5ms、不重放或扩量。
5. R0闭合才派发R1，新前缀。除account_read_candidate=true外，其余输入与R0一致，仍contract_load_detail=true；同样完成业务、关联、预算与清理。优先比较两组共同BASELINE物理冷409；没有共同基线才比较共同INDEPENDENT_SAMPLING，不混组、不补样、不通过重启或预热制造冷。
6. 两组清理后同SHA关闭恢复：engine_cpu_diagnosis=true、authenticated_preconnect=false、account_read_candidate=false、**contract_load_detail=false**、rollout_phase=immediate。失败路径也必须恢复。核对三个实际false、19代码/非API revision、预算及恢复后的只读空集。

```sh
node scripts/analyze-qa09-contract-load-detail.mjs --prepare FULL_40_CHARACTER_PUSHED_SHA NEW_PLANNED_INPUTS.json
node scripts/check-qa09-contract-phases.mjs CHILD.json PATCH.json AUDIT.json NEW_PHASE_GATE.json --account-phases --client-preparation --client-split --engine-cpu --runtime-assembly --authenticated-preconnect --contract-load-split --contract-load-detail
# 独立采样另加 --cold-sampling；物理冷证明另加 --require-cold-conflict。
node scripts/qa09-account-read-config.mjs PUBLISHED_INPUTS.json SAME_SHA_19_VERSION.json NEW_ACTUAL_CONFIG_GATE.json
node scripts/record-qa09-deployment-inputs.mjs --account-read-pair R0_PUBLISHED_INPUTS.json R1_PUBLISHED_INPUTS.json NEW_INPUT_PAIR.json
node scripts/analyze-qa09-contract-load-detail.mjs R0_MATCHED_MANIFEST.json R1_MATCHED_MANIFEST.json NEW_DETAIL_OBSERVATIONS.json
```

两个matched manifest都必须顶层`requireContractLoadSplit=true`、`requireContractLoadDetail=true`和`inputs.contractLoadDetail=true`；在原receipts之外添加`inputs:{path:"qa09-deployment-inputs.json",sha256:"实际64位哈希"}`。该文件必须来自相同运行的发布工件，deployment-input-binding.json的`bindings["qa09-deployment-inputs.json"]`必须等于其哈希。加载器核对受控目录/原字节、同SHA/运行/候选/预算context及实际contractLoadDetail="true"，再检查阶段和既有清理/19工件/REPORT；单独填manifest开关不能补成证明。

解析器不保存SQL、参数、结果、凭据或原异常正文，只允许安全请求标识、阶段、数值CPU/计数/时间与固定边界。分析输出仅OBSERVATIONS_ONLY：公开等待与pg前/结算/后比例；不声称compiler/server独占、模型成本因果后移、总体收益、P95或完整QA-09通过。缺匹配自然冷记NOT_OBSERVED，不增加样本。

## 未决边界

TCP/TLS独立长尾沿用前轮正常TLS、无登录Node/curl证据，暂无第二授权主机/网络，具体网络节点UNRESOLVED。新业务采样继续分开记录客户端传输与应用阶段，不用ORM子段解释TCP/TLS，不将两类样本合并为P95。独立设备验签/自然Active、真实邀请发送仍保留既有NOT_RUN；不调整IAM/KMS，不发送邀请。
