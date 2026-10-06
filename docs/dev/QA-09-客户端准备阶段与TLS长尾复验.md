# QA-09 数据库客户端准备阶段与TLS长尾复验

2026-10-06。依据f341f68真实冷409：账号query1717ms、query开始至首次驱动查询1075ms、首次驱动查询641ms/checkout602ms。新增观测只能在新版本部署后解释新的样本，不能回填旧1075ms的内部步骤。

## 观测边界

| 阶段 | 边界 |
| --- | --- |
| db-client-prepare | 每trace首个公开Prisma query extension进入→该操作自身root adapter派发；包括客户端准备、编译/规划、调度，不包含随后SQL/checkout |
| db-adapter-connect | lazy adapter factory进入→PrismaPg adapter对象返回；只构造pool，不主动checkout或SQL |
| db-client-after-adapter | 同一首操作的adapter返回→自身root adapter派发；包含查询编译器准备/查询规划/调度，不能单凭此字段认定纯WASM/CPU |
| db-first-query / db-first-connection | 既有首次root驱动查询/checkout边界，保持不变 |

只为每trace首操作声明准备计时，AsyncLocalStorage隔离其执行上下文；共享初始化或同trace其他操作不能提前结束该操作计时。无trace无事件，保留lazy PrismaPromise、原错误和batch/interactive事务/断开所有权。操作没有root driver派发时以OPERATION_SETTLED或OPERATION_FAILED收尾，不能冒充DRIVER_DISPATCH；SQL派发之后的SQL错误不改写准备PASS。

真实客户端在warm请求不重建adapter，所以adapter/suffix阶段可缺失并显示null。冷请求必须有这两个精确嵌套阶段。准备事件只记录安全阶段名、时间、固定completionBoundary及安全错误码，不记录SQL、模型名、args、连接URL、账号或密钥。

## 新版本业务复验

必须先由人工GitHub Desktop推送最终代码提交，再核对同SHA CI/Deploy/Amplify及19实际ZIP字节；不得以f341f68旧19工件证明新观测已发布。保留512MiB/保留并发12/pool1，不扩容、不重启共享Lambda、不改IAM/KMS，不发邀请或绕过Active/设备验签。

```sh
QA09_EXPECTED_COMMIT=<new-full-sha> QA09_DEPLOY_RUN_ID=<new-deploy-run> QA09_CODE_RANGE_TRANSPORT=sdk node scripts/collect-qa09-application-version.mjs <new-dir>/application-version.json
node --import tsx scripts/run-qa09-nonactive-target.mjs <new-dir>/sample.json <new-dir>/application-version.json --cold409-sampling
python3 scripts/collect-qa09-contract-correlation.py <new-dir>/sample.json <new-dir>/baseline-patch.json
python3 scripts/collect-qa09-contract-correlation.py <new-dir>/sample.json <new-dir>/baseline-audit.json --audit-get
node scripts/check-qa09-contract-phases.mjs <new-dir>/sample.json <new-dir>/baseline-patch.json <new-dir>/baseline-audit.json <new-dir>/baseline-phases.json --account-phases --client-preparation
# 只有基线实际取得冷409时，严格分析才可通过
node scripts/check-qa09-contract-phases.mjs <new-dir>/sample.json <new-dir>/baseline-patch.json <new-dir>/baseline-audit.json <new-dir>/baseline-cold.json --account-phases --client-preparation --require-cold-conflict
node scripts/analyze-qa09-account-phases.mjs <new-dir>/sample.json <new-dir>/baseline-patch.json <new-dir>/baseline-audit.json <new-dir>/baseline-analysis.json --client-preparation
python3 scripts/collect-qa09-contract-correlation.py <new-dir>/sample.json <new-dir>/sampling-patch.json --cold-sampling
python3 scripts/collect-qa09-contract-correlation.py <new-dir>/sample.json <new-dir>/sampling-audit.json --cold-sampling --audit-get
node scripts/check-qa09-contract-phases.mjs <new-dir>/sample.json <new-dir>/sampling-patch.json <new-dir>/sampling-audit.json <new-dir>/sampling-phases.json --account-phases --client-preparation --cold-sampling
node scripts/check-qa09-contract-phases.mjs <new-dir>/sample.json <new-dir>/sampling-patch.json <new-dir>/sampling-audit.json <new-dir>/sampling-cold.json --account-phases --client-preparation --cold-sampling --require-cold-conflict
node scripts/analyze-qa09-account-phases.mjs <new-dir>/sample.json <new-dir>/sampling-patch.json <new-dir>/sampling-audit.json <new-dir>/sampling-analysis.json --cold-sampling --client-preparation
QA09_EXPECTED_COMMIT=<new-full-sha> QA09_DEPLOY_RUN_ID=<new-deploy-run> node scripts/collect-qa09-application-version.mjs <new-dir>/runtime-final.json --runtime-only
```

分别保存所有stdout/stderr/exit；阶段缺失、未知completionBoundary、错误UUID/窗口、warm假adapter或未取得真实冷409不能通过。基线冷证明必须追加与其Lambda invocation精确对应的唯一REPORT Init Duration>0/512MiB；采样严格Gate已内置此要求。`--client-preparation`是新观测必选，不带此旗标的旧回执只能证明历史范围。分析器返回新增准备/adapter/suffix、query→extension、prepare→adapter开始和准备残差；它们都嵌套在账号hook中，禁止重复累加，也不能推断纯CPU/SQL/锁时间。

完成父子/身份/客户站点/归档清理和独立AWS内audit-empty，与最初19 ZIP配对尾段版本无漂移。原三轮和独立采样保持分开的Gate；任何冷样本集未命中仍保留COLD_CONFLICT_REQUIRED，严格分析NOT_RUN，不混用另一集合的成功记录。预算与清理步骤同[有界冷采样手册](QA-09-预算内冷409采样与客户端传输复验.md)。

## 独立TLS只读诊断

```sh
node scripts/qa09-tls-diagnostic.mjs <dir>/tls-target.json
```

固定现有测试API contracts GET，无凭据、预期401、没有业务写入。共12次：全新TLS会话3次（每次独立agent、禁用TLS会话缓存），pooled顺序3次（同一有界agent），parallel6次（同一agent，最多6个总socket）。每次20秒总截止、不自动重试、强制正常证书验证；响应体完整读取后丢弃。记录socket阶段、TLS协议/标准cipher/authorized/sessionReused以及进程级event-loop延迟，不记录证书、会话ticket/key、IP、URL、完整头/体、密码或Token。

TCP复用与TLS session恢复分别记录，复用socket的DNS/TCP/TLS为null。TLS阶段是TCP connect至secureConnect的事件间隔；正常证书验证成功不证明每个网络节点正常。event-loop histogram不是逐请求CPU profiler，没有同量级主线程阻塞也不能证明丢包、重传、代理/VPN、服务端节点或操作系统调度的具体根因。样本只有12次，禁止以描述性最大值/对照推导P95或业务性能验收。

回退：回退本次工厂query extension/adapter计时及新增观测阶段，保留既有pool和连接/查询计时；不改数据库数据或容量。旧阶段检查默认兼容，不以禁用新旗标来宣称新准备阶段通过。
