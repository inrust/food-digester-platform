# BE-RPL-01 消息重放服务和管理接口

任务来源：`docs/管理后台开发任务清单.md` L541-549（BE-RPL-01，依赖 BE-ARC-02 / BE-IOT-02 / AUTH-01 / DOM-03）。

## 范围

按 Customer、设备、时间和序号范围创建 replay job；从 S3 读取归档原始记录重新投入 Ingress；提供任务状态、成功/跳过/失败统计。不包含 DLQ 人工值守和运维处置流程。

## 实现

**Admin API（cloud-api）**：`apps/cloud-api/src/admin/replay/`

| 文件 | 职责 |
| --- | --- |
| [service.ts](../apps/cloud-api/src/admin/replay/service.ts) | `parseReplayScope`（customerId 存在 404；deviceId 须属于该 Customer——**跨 Customer 拒绝 400**；from<=to；topicType 限可归档类型；seqFrom<=seqTo）+ `createReplayJob`（job 落库 + `replay.job.create` 审计同事务） |
| [repository.ts](../apps/cloud-api/src/admin/replay/repository.ts) | 键集游标分页列表（customerId/status 过滤）+ 详情 |
| [handler.ts](../apps/cloud-api/src/admin/replay/handler.ts) | 三端点均 `withAuthorization({permission: 'replay:create'})`——权限矩阵持有者恰为 PlatformSuperAdmin/PlatformOperator（AUTH-01 既有权限点，无需矩阵变更） |

**Replay Worker（ingestion-worker）**：[worker.ts](../apps/ingestion-worker/src/replay/worker.ts) `createReplayWorker({client, reader, sink})` → `executeJob(jobId)`：

- 状态机：PENDING →（条件领取）RUNNING → COMPLETED/FAILED + resultSummary（scannedObjects/scannedLines/sent/skipped/failed）+ completedAt；非 PENDING 重复执行幂等 no-op（ALREADY_DONE）；
- 读取：按 scope.topicType（缺省六类）× [from,to] UTC 小时窗口枚举规定前缀 → NDJSON/GZIP 逐行解析；
- **记录级过滤独立于前缀**：行内 customerId 断言、设备/时间/序号范围——范围外记录不进入队列（skipped）；
- **重放沿用原幂等键**：重投记录携带原始上行 Payload（meta.id/meta.seq 原样），BE-IOT-03 receipt 去重 → 已处理消息重放不复制业务记录；
- 单条重投失败计入 failed 不中断；任务级异常 → FAILED + 错误摘要；
- 每次执行写审计（`replay.job.execute`，SUCCESS/FAILURE）。

**契约**：[admin-replay-api.json](../contracts/rest/admin-replay-api.json)（三端点 + ReplayScope/ReplayJob/ResultSummary 封闭 Schema）+ 契约测试。

## 验收证据

- API 测试：[admin-replay.test.ts](../apps/cloud-api/test/admin-replay.test.ts)（PGlite），5 项：Operator 创建 201+审计；CustomerAdmin/Auditor/匿名 401/403、SuperAdmin 放行；跨 Customer 设备引用 400、Customer/设备不存在 404；五类范围校验 400；两页键集游标覆盖不重复 + customerId 过滤 + 详情 404。
- Worker 测试：[replay-worker.test.ts](../apps/ingestion-worker/test/replay-worker.test.ts)（PGlite + 内存 Reader/Sink），4 项：
  1. 范围内 2 条重投（原 meta.id/seq 断言）、范围外 4 条（设备/时间/序号/Customer）skipped、COMPLETED + 统计 + SUCCESS 审计；
  2. **端到端幂等**：重放记录经 BE-IOT-05 telemetry handler——首轮 PROCESSED（sampleCount=2），二轮同范围重放 DUPLICATE_SKIPPED、sampleCount 不变（不复制业务记录）；
  3. 单条重投失败计入 failed；COMPLETED 任务重复执行 ALREADY_DONE 不再投递；
  4. 读取异常 → FAILED + 错误摘要 + FAILURE 审计。

命令与结果：

```text
pnpm vitest run apps/cloud-api/test/admin-replay.test.ts apps/ingestion-worker/test/replay-worker.test.ts   → 9 passed
pnpm verify                                                                                                 → EXIT=0（52 文件 395 项 + 全部门禁）
```

## 未决风险

- 重投记录不含 iotPrincipal（归档未保留证书 ARN）：部署适配层需注入设备当前 ACTIVE 证书 ARN 才能过 BE-IOT-02 身份校验（已在 ReplayIngressRecord 文档标注）。
- Job 调度触发（API 创建后异步执行：SQS/Lambda 或轮询）归部署接线；本任务交付 executeJob 纯函数语义。
- 大范围重放（多月）按小时枚举前缀无上限保护；V1 接受（管理端低频操作）。
