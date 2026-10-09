# QA-09 合同 await 微任务分界与离线读取候选复验

依据：[24d50d6 目标对照](../audit/QA-09-24d50d6父清理与统一采集R0-R1目标复验-2026-10-09.md)。R1 首次合同 ORM await 为465ms；R0对应为3ms。旧回执没有本轮检查点，不能追溯拆分或补成新 Gate。

## 公开分界与默认值

沿用默认关闭的 `FDP_QA09_CONTRACT_LOAD_DETAIL`，无需新环境变量。既有 test/pool1/engine/preconnect guard、仅ApiFn、push固定false保持；只有原详细观察模式才排入一个 `queueMicrotask`。不await检查点、不替换原 `query(args)` Promise、不增加SQL/连接/重试，不用compiler私有API。

| 新阶段 | 边界 | 解释限制 |
| --- | --- | --- |
| contract-load-await-queue | query(args)同步返回 → 本次microtask执行 | 含观察成本和公开排队；不是纯event-loop等待 |
| contract-load-await-after-queue | 检查点 → 原事务adapter dispatch | 含惰性准备、编译、调度及观察成本；不是纯compiler |

共享原始单调/墙钟/CPU分界，两个子段覆盖原 `contract-load-orm-await`，严格容差仍5ms。CPU为PROCESS_ALL_THREADS；两段 `includesConnectionWait=false` 只标识不覆盖数据库checkout，并不证明纯CPU。整数0ms表示量化结果，不能当成无成本。日志及检查点会扰动后段，目标两组须同时开启相同观测。

观察回调绑定原trace且吞掉观察异常；原业务异常不替换。原读取提前派发、失败、缺检查点、重复归属、缺pg结算时严格Gate失败，不能合成零段或放宽容差。普通/精确采集共用固定MICROTASK_CHECKPOINT白名单。新 `--contract-await-checkpoint` 必须同时使用 `--contract-load-detail`；旧回执在新required模式下失败。

## 离线候选与预算

`readContractForUpdate(tx,id,true)` 是参数化原生单行读取，只投影原合同12个标量字段；id保持schema的text类型，不拼接输入、不缓存结果。默认false仍走原模型读取，服务默认路径保留原loadContract调用结构。仅 `updateContract` 的首次读取接受显式内部deps opt-in，其他动作不变。true必须pool1且在原事务内，禁止根client；严格检查ID/日期/版本/空结果/行数，失败不回退、不重试。

**候选尚无Admin运行时、环境变量、CDK或workflow接线**；HTTP参数不能开启。离线矩阵固定11个新Node进程、串行、每个45秒、pool1、0网络/服务器/目标夹具。账号读取均为原生模式，对比首次合同ORM/原生，继续测量同一事务的版本updateMany、合同findFirst读回与auditLog.create。审计返回投影仅id，是离线子集，不冒充完整业务目标计时。真实PGlite另验证完整service成功/409/404/非法状态窗口、审计失败回滚和原五角色权限。

原生读取的modelEntries=0必须如实记录，不能满足旧Contract模型详细证明。首次模型成本可能转移至版本更新/读回；若仅首读缩短而整条业务不改善，保持默认关闭。本轮不实施更多原生写入或同pool重叠，不增加容量。

```sh
node scripts/run-qa09-contract-await-offline.mjs NEW_OFFLINE_DIRECTORY
pnpm exec vitest run apps/cloud-api/test/admin-contract-load-candidate.test.ts packages/database/test/contract-await-offline.test.ts packages/database/test/contract-load-detail.test.ts
node --test scripts/qa09-contract-load-detail-proof.test.mjs
```

## 新SHA目标顺序（本轮未执行）

1. 人工通过GitHub Desktop推送实现提交。核对同完整SHA CI/push默认关闭部署/Amplify及19实际ZIP/S3/配置，首次新SHA不得复用24d50d6工件。
2. 使用新目录和新前缀；执行[原详细复验手册](QA-09-ORM提交与pg结算默认关闭观测复验.md)的SSO/清理余量、受控容量、数据库预算入口，不重启UNKNOWN Plan。
3. R0手动部署：engine=true、preconnect=true、account=false、detail=true、immediate；绑定发布输入字节/运行ID、实际配置、19工件。执行原123业务及限定采样，逐请求关联HTTP/Gateway/Lambda/REPORT、新旧阶段、预算和原父子清理/独立空集。
4. R0全部闭合才进入新前缀R1；仅account=true，其余相同，合同原生候选仍未接线。优先共同BASELINE物理冷409；无共同基线才用共同INDEPENDENT_SAMPLING，不混组、不扩量或制造冷。
5. R1清理后恢复同SHA：engine=true、preconnect=false、account=false、detail=false、immediate。失败也先清理和关闭恢复；复核三个实际false、19代码/非API revision、预算、独立空集、归档零版本和所有已知Build终态。
6. 两个matched manifest均添加顶层 `requireContractAwaitCheckpoint=true`、`contractReadCandidate=false`，保持原 `requireContractLoadSplit=true`、`requireContractLoadDetail=true` 和原发布inputs字节绑定。严格加载器会将新required标志传入阶段检查；旧manifest不能升级。

```sh
node scripts/analyze-qa09-contract-await.mjs --prepare FULL_40_CHARACTER_PUSHED_SHA NEW_INPUTS.json
node scripts/check-qa09-contract-phases.mjs CHILD.json PATCH.json AUDIT.json NEW_PHASE_GATE.json --account-phases --client-preparation --client-split --engine-cpu --runtime-assembly --authenticated-preconnect --contract-load-split --contract-load-detail --contract-await-checkpoint
# 独立采样另加 --cold-sampling；物理冷证明另加 --require-cold-conflict。
node scripts/analyze-qa09-contract-await.mjs R0_MATCHED_MANIFEST.json R1_MATCHED_MANIFEST.json NEW_AWAIT_OBSERVATIONS.json
```

此对照验证新观测及既有账号候选，不验证离线合同原生候选的目标收益。若后续决定将合同候选接线，需另补默认关闭runtime/部署/实际输入绑定及原生读取归属Gate，固定账号模式配对，重新验证完整业务/审计/冲突；不能将旧R0/R1或首读单段当成候选收益证明。

## 独立传输诊断

固定测试端点无登录GET：既有curl6次串行、Node12次（新会话/复用/最多6并发）、20秒deadline、正常TLS、无重试、无业务写入。保存安全请求标识和客户端阶段，不保存凭据/响应正文。TCP/TLS/响应等待分别报告，复用时DNS/TCP/TLS保留null。暂无第二授权主机/网络，具体节点归因UNRESOLVED；不以ORM阶段解释传输或合并样本验收P95。

整体QA-09/P95仍PARTIAL；HMAC独立验签/自然Active/邀请发送沿用NOT_RUN。本轮不修改IAM/KMS/容量，不创建目标业务夹具或派发部署。
