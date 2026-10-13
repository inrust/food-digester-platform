# QA09-CLOSE-07 非空 Replay 与精确队列去重复验

本手册用于现有测试环境业务收口，不恢复性能 R0/R1。不要求设备 Active，不伪造 VERIFIED。IAM/KMS 前置不足时记录 BLOCKED，不调整权限或共享资源。

## 入口与命令

先在新证据目录保存核验通过的 `application-version.json`，再执行 `collect-qa09-reliability-reconciliation.mjs` 合并历史原始回执、原始失败、纠错及清理证据，逐 Git 根输入比较受验应用。源码相同也不证明历史运行配置相同。原空源 Replay、仅 SendMessage 成功均不属于实际消费验收。

新目录必须为空；先核对同 SHA 成功 CI/部署、19 工件字节、Amplify 和当前 API 配置，pool1/512MiB/并发12及五候选 false；SSO 登录余量至少10分钟，角色清理余量至少75分钟。显式使用已核验 SHA 和部署 ID：

```sh
QA09_EXPECTED_COMMIT=<完整受验SHA> QA09_DEPLOY_RUN_ID=<成功部署ID> \
  node --import tsx scripts/run-qa09-reliability-closeout-target.mjs \
  <新目录>/target.json <新目录>/application-version.json
```

执行器冻结实际源码和依赖锁文件，受验应用与本地验收工具分别绑定。运行过程中不修改冻结的执行器。创建2个专用Customer和10设备，使用真实SRP/CSR/mTLS/MQTT，设备自然达到 Onboarded。临时身份使用 SUPPRESS；私钥、密码、Token、原始消息仅留内存。可靠性收口执行器在每设备Telemetry首次发布前建立新的同身份连接（关闭自动重连），单次PUBACK功能等待最多45秒，不重发未知消息；旧十设备执行器默认仍为10秒。45秒是本地功能执行截止，不是MQTT/API可见P95通过阈值，原10秒失败不改。

## 业务证明

1. 核对30条唯一已处理消息、每设备2个Telemetry样本，以及20条Telemetry原始归档哈希；临时只读归档探针沿用既有Replay角色，核对策略摘要并删除探针，不写IAM。
2. 选择本轮 `-03` 设备第一条原始Telemetry，与发布账本、数据库receipt、有效证书及归档证明绑定。读取只读去重基线，不创建额外业务消息。
3. POST真实Replay Job，精确Customer/Device/telemetry、原发生时间±1秒、同一seq上下界。要求持久化scope、COMPLETED且 `sent=1`、扫描非空、失败计数全0及create/execute审计。空源COMPLETED不能通过。
4. 采集该消息在Replay创建后的消费元数据；Replay生产者目前没有返回SQS ID，不声称Job ID到SQS ID的直接日志关联。另以同一原始消息执行一次精确SQS重复提交，maxAttempts=1、15秒超时，记录返回MessageId。权限拒绝保留BLOCKED；丢响应/超时为UNKNOWN，不补发。
5. 精确消费者要求相同SQS ID、原消息ID、设备ID、原receipt ID、Lambda invocation，root `DUPLICATE_SKIPPED/ROOT_TRANSACTION_COMPLETED` 和最终 `PROCESSED`同时存在。只读日志每页100条、最多8页/轮、6轮、全局90秒，每CLI不超过10秒；固定字段投影，不保留任意错误或载荷。
6. 前后只读数据库指纹比较ingestion_receipts、hourly/daily聚合及设备ARCHIVE outbox，原receipt内容保持不变。Replay Job及其outbox按自有范围清理，随后父流程清理证书/Thing、设备数据、S3所有版本、Customer和Cognito身份。

## 所有权及停止条件

StartBuild沿用现有精确Plan/源码/时间窗绑定的小批只读恢复，原FAIL/UNKNOWN不覆盖，禁止重启原Plan。非空Replay POST在调用前记录ATTEMPTING，响应未知不重复POST；Job未终止或写入结果未知时暂停破坏性父清理，保留精确夹具账本供只读恢复。清理失败不把业务检查升级为完整PASS。

实跑后独立核对数据库空集/原设备证书摘要、精确自有Build终态、Cognito空集、S3版本空集及未变的实际配置。生成合并后账本和内容摘要清单。分别报告非空Replay、Replay关联消费、直接队列重投、去重、审计、清理和完整QA-09；不得用局部PASS冒充整体验收。当前版本导出租约恢复、归档/ESG全链一致性仍需各自回执。


## 清理后的独立评估命令

以下输出路径均须未存在；已启动的最终只读Build不重启。初始应用版本回执保留不覆盖，最终版本/配置另存文件，避免改变执行器绑定的versionSha256。

```sh
node scripts/qa09-replay-dedup-assessment.mjs <新目录>/target.json <新目录>/hourly-dedup-assessment.json
node --import tsx scripts/collect-qa09-reliability-final.mjs <新目录>/target.json <新目录>/final-readonly.json
node --import tsx scripts/collect-qa09-reliability-reconciliation.mjs <新目录>/reconciliation-after.json <完整受验SHA> <新目录>/target.json.reliability.json
```

原四表全非空Gate不放宽；日报0行时原dedupGate仍NO_RECEIPT。限定评估要求30条PROCESSED原receipt、10 hourly、20 ARCHIVE outbox及范围外指纹前后一致，精确消费证明按同SQS ID/原消息/receipt/设备/调用重新计算，只能输出PASS_HOURLY_ARCHIVE_DEDUP_SCOPE。daily空集未变不证明日报或ESG计算通过，fullQa09Accepted始终false。直接SSO投递被KMS拒绝时保持BLOCKED，不以Replay消费证明替代该场景，也不在本任务中调整KMS。
