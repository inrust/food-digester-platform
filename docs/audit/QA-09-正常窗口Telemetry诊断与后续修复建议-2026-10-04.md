# QA-09 正常窗口 Telemetry 诊断与后续修复建议（2026-10-04）

应用版本 `0abf7cf299e0cda1d10ad9c1c1723a1735e3c388`；现有测试环境。本文件记录只读诊断与后续开发建议，本轮未修改容量、连接池、IAM/KMS 或发布应用。

## 实测与解释边界

- 新前缀 `qa09-0365153b90e468c3`，确认30条基线处理完成、ARCHIVE全部PUBLISHED后测量，无前序quick突发；20条Telemetry均可见，P95 **7635ms，FAIL**；20条在线Command均收到，P95 **2017ms，PASS**。首次主轮分别9847/1550ms，保留原结果。
- [逐消息诊断关联](evidence/qa-09-continuation-2026-10-04/normal-slo-diagnostic-join.json) 将20个MQTT messageId、deviceId、seq与RDS唯一行、API轮询requestId/耗时关联。`processed_at - occurred_at` P95为1184ms，但 `apps/ingestion-worker/src/ingest/receipt.ts` 在业务更新、Outbox、gap处理和事务提交**之前**写此时间。该值不证明事务已提交，不可据此排除Ingestion延迟。
- 正常窗口14:50–15:01 UTC分钟指标：Ingress可见积压及最老年龄最大均0；Ingestion并发最大1，分钟Throttles最大10；Duration取每分钟p95后最大约6618ms。API无Errors/Throttles，但分钟p95 Duration最大约3694ms。分钟指标不是逐请求因果证明，也不代表绝无瞬时积压。
- Ingress事件源BatchSize10、批等待0；不能把5秒批等待当作已证实原因。控制台查询读取同设备最新小时所有站点桶加权聚合；一次console同时发起多个Prisma查询，pool1会排队。仅据源码无法确定哪条查询占主耗时。
- API当前512MB，Ingestion256MB，实际连接池与只读配置回执单列；未输出数据库Secret。

## 下一开发任务及连接预算

1. 在成功/去重路径补固定结构化字段：SQS messageId、设备事件messageId/seq、receiptId、Lambda requestId、receivedAt、事务开始/提交完成时间、结果分类与阶段duration。API记录requestId、路由模板、连接等待、领域查询/序列化耗时与返回快照观测时间；禁止记录Token、payload、Secret、原始异常message。去重分支也需消费级关联，否则唯一行不增不能证明某次重投已被消费。
2. 在pool1下复核console查询计划和查询数；必要时合并参数化读取，保留客户隔离、跨站点桶加权、缺数据null及稳定排序测试。先获得每阶段实测，再选择查询优化。
3. 当前IaC `databaseCapacity(true,true)` 的统一预算为普通连接70、运维8、闲置重叠10，稳态45，总计63，余量7。所有DB Lambda的reserve×pool必须统一核算；不得只放大API池。优先比较Ingestion256→512MB，保持pool1与并发1；内存候选不增加声明DB连接，但成本和冷/热表现需实测。若观测证实并发瓶颈，Ingestion1→2/pool1候选总计64≤70，仍需统一IaC、事件源限制、预算回归、实际RDS连接证据及部署回滚材料，不能当作已实施修复。
4. 每次变更先本地测试，再由人工推送；取得新提交部署和字节绑定后用新夹具复验。冷/热均计入、保持同一20样本定义，同时保留MQTT实际速率、API可见≤5秒、在线Command≤3秒、RDS不丢/不重、S3五分钟字节核验与完整清理回执。失败样本不得筛除或替换成旧版本绿色结果。
5. 队列重投本轮被现有KMS解密授权阻断，无提交或特定消费证明；运维前置由管理员处理。应用侧先补消费关联能力；前置落实后再对本轮新夹具提交与核验，不读取或清空共享队列，不自行修改权限。

完整QA-09仍为PARTIAL。此方案与自然生命周期、JWT状态契约、全部合法写分支、117项语义行为的未决项分别验收；诊断通过不解除业务Gate。
