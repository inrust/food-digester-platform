# QA-09 ORM 准备与驱动窗口离线分界及对照

依据：[17fb6f1 目标复验](../audit/QA-09-17fb6f1合同读取分段R0-R1目标复验-2026-10-08.md)。R1 的公开 ORM 准备为502ms，driver-query为132ms；两者没有更细的目标边界，不能回填为纯编译或服务器执行成本。本轮只新增离线诊断和测试；目标部署与两个默认关闭候选保持原状。

## 可重复输入与预算

```sh
node scripts/run-qa09-contract-load-offline.mjs NEW_EMPTY_OUTPUT_DIRECTORY
node --test scripts/qa09-contract-load-offline.test.mjs scripts/qa09-contract-load-proof.test.mjs
pnpm exec vitest run packages/database/test/contract-load-offline.test.ts
```

使用真实生成的PrismaClient、ObservedPrismaPg与Prisma pg适配器；仅在测试进程替换pg连接和查询端口，禁止真实socket/数据库服务器。每个场景独立Node进程，8进程顺序执行，每进程45秒截止；单pool/max1。先执行既有authenticated preconnect，再执行生产`readAuthenticatedAccount`一次（ORM或原生参数化读取），随后相同`Contract.findFirst({where:{id}})`全字段事务读取。账号受控结果为不存在；不声称覆盖真实账号状态、权限或更新/审计业务链路。

ORM/原生账号读取各有零延迟、30ms受控驱动等待、20ms受控fields访问CPU三种场景。每个成功场景同一client连续3次读取：第一次与随后两次；失败场景只执行一次（驱动40001拒绝、非法模型输入）。不预读Contract，不增加SQL、查询重试、缓存、第二pool或目标夹具。每个场景必须验证账号查询一次、每成功读取一个事务查询、提交/回滚/释放/销毁数量；非法模型输入应在驱动前拒绝。失败必须出现contract-load FAIL，保留原回滚，不升级为成功分段证明。

默认仓库测试执行8场景；独立运行器通过`QA09_OFFLINE_CASE`和`QA09_OFFLINE_OUTPUT`选择单场景并生成新回执。输出已存在时拒绝覆盖。矩阵绑定诊断源码、实际适配器字节、账号/合同实现、schema和lockfile；分析前复核源文件与各场景回执哈希。进程冷启动、第一次client模型调用与Lambda自然冷是不同概念。

## 离线公开边界

| 区间 | 观测点与解释 |
| --- | --- |
| publicQueryCall | 离线追加的Contract公开扩展调用query(args)，至其返回Promise；没有await，不声称包围compiler |
| returnToAdapter | query(args)返回至原事务queryRaw入口；包含惰性执行、准备、规划和调度 |
| adapterToPg | 原事务适配器入口至受控pg.query入口；包括观测完成日志与参数转换 |
| controlledPg | 受控pg.query入口至受控结果就绪；注入30ms等待；不是真实网络/服务器计时 |
| resultReadyToFields | 受控结果就绪至适配器首次读取fields；含Promise微任务调度 |
| controlledFieldsCpu | 适配器读取fields的受控getter；注入20ms CPU，不是实测解码成本 |
| fieldsReadyToAdapter | fields可用至原适配器Promise结算；含字段类型映射和结果处理/调度 |

后五段共享记录点，其和必须覆盖离线adapterTotal（只允许0.01ms舍入差）。原生产四段仍独立调用既有严格检查器，5ms容差不变；PROCESS_ALL_THREADS不改为compiler独占CPU。追加扩展、测试包装及受控getter影响测量，不能把离线adapterTotal直接代入目标132ms。pg Promise结算前真实pg解析也属于驱动窗口，不能将适配器字段映射等同全部解码。

## 目标环境下一阶段候选

1. 将公开`query(args)`同步返回与后续事务适配器dispatch分开观察，使用共享单调/墙钟/CPU边界；不得先await query再记录提交返回，也不得使用Prisma私有compiler方法。
2. 如需拆132ms，仅在本次Contract读取的ALS所有权内观察真实pg查询提交/Promise或callback结算与原适配器结算；先离线覆盖pg全部使用中的重载、异常、Promise身份、并发上下文及释放恢复，再接线。事务BEGIN/commit/rollback和checkout超时保持原逻辑；不能把pg等待标为服务器执行。
3. 目标观测默认关闭；复用pool1/512MiB/reserved12与静态63≤可用70，不以增加内存、并发、pool或预热解决观测问题。没有预算内收益证明时继续关闭账号读取候选；暂不实施准备工作重叠或字段/查询语义优化。
4. 人工推送未来实现SHA后，重新核对同SHA CI/部署及19实际工件。按既有R0→清理→R1→清理→关闭恢复顺序，最多6并发、6基线PATCH及12独立采样；不补样、不造冷、不混新旧SHA或采样类型。必须绑定新子段和所有权、HTTP/Lambda/REPORT、预算和独立空集；缺共同自然冷则NOT_OBSERVED。
5. 先判定502ms主要在同步提交还是返回后等待、132ms主要在pg结算前还是结算后，再决定优化。单条冷样仅OBSERVATIONS_ONLY，不能推导总体收益/P95；目标子段本轮NOT_RUN。

## 传输独立对照

```sh
node scripts/qa09-tls-diagnostic.mjs NEW_NODE_TRANSPORT.json
# Node完成后再运行curl，避免两组并发叠加。
node scripts/qa09-curl-transport-diagnostic.mjs NEW_CURL_TRANSPORT.json
```

固定目标无登录GET；Node12次/最多6并发/20秒截止，curl6次/顺序/20秒截止/无重试。正常TLS、curlrc禁用，不保存正文或凭据。Node比较新TLS session、池复用和受限并发；curl比较默认与IPv4，二者可能同路由，不作为第二网络。DNS/TCP/TLS缺值保持null。进程级事件循环直方图不能归因到单请求或网络节点；没有另一授权网络，节点仍UNRESOLVED。与合同业务耗时和P95分开。
