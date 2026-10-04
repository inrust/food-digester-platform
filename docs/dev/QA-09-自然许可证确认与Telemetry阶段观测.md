# QA-09 自然许可证确认与 Telemetry 阶段观测

本轮落实既有 DOM-01 的 Assigned→Licensed→Active 条件和 DEC-020 的许可证签名规范。范围是现有 AWS 测试环境的应用代码、协议、测试及复验驱动；不调整 IAM/KMS、连接池、并发、事件源或内存。新源码需人工推送、同 SHA 部署和工件核对后才能用于目标复验。

## 许可证确认协议

`POST /api/v1/device/sync` 仍返回完整顶层快照。旧请求 `{}` 或 `{lastSyncTime:null}` 可继续使用，单独 lastSyncTime 不证明设备收到或验签许可证。REST Sync 片段版本为 0.3.0、契约包为 0.13.0；0.11.0、0.12.0 基线及旧兼容批准清单保留。封闭响应的扩展会影响严格旧客户端，兼容 Gate 按版本变更处理，不能宣称旧固件已支持新确认。

设备先 Sync 获取许可证及 etag，然后用同一 mTLS 身份确认：

```json
{
  "licenseConfirmation": {
    "licenseId": "00000000-0000-4000-8000-000000000001",
    "version": 1,
    "snapshotEtag": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "RECEIVED"
  }
}
```

示例标识仅供说明，必须使用本设备刚收到的真实值。RECEIVED 在 Assigned 状态通过 SYSTEM 领域迁移到 Licensed。设备独立验证 HMAC 成功后才可将 status 改为 VERIFIED；需要同一绑定下已有 RECEIVED，Licensed 经 DEVICE 领域迁移到 Active，并同步 operational Active。服务器认证的是设备的明确声明，不会替固件计算或证明独立验签；被攻陷设备可能谎报，该协议不是远程固件证明。

服务端在 Lambda 响应序列化成功、交回 Gateway **之前**记录 snapshot-served，因此它只证明服务端准备交付，不能单独证明网络交付。客户端后续 RECEIVED 才是收取声明。绑定落在现有追加审计表，无新增迁移：设备、许可证 ID/version、快照 etag、证书指纹、签名摘要、当前 assignment/customer/site、servedAt。审计不保存签名、密钥或完整 Sync 内容。

确认事务依次锁设备、证书、当前分配和许可证，复核证书 ACTIVE/有效期、归属、有效许可证、版本和签名摘要。已提交交付记录须在当前时刻之前且年龄 **≤24小时**；超过24小时、换证、重分配、更新版本/签名、过期/撤销、Suspended/Retired 返回409（身份失效按401/403）。重复声明不重复状态历史或运行镜像。确认审计失败会回滚状态、历史及确认记录。并发数据库冲突可重试，但必须重新读取当前快照，不可覆盖新版本。

`license.signaturePayload` 提供 DEC-020 规范输入：固定顺序 `licenseId/deviceId/customerId/validFrom/validTo/entitlements`，时间保留完整 UTC ISO-8601，entitlements 使用线协议名称并排序；沿用 `v1.<base64url HMAC-SHA256>` 及 active/previous/legacy 规则。原 validFrom/validTo 日期展示字段保留，不能用于重建签名。Draft 的 signature 为 null，不能确认接收。新增 signaturePayload 在 Schema 中是兼容可选字段，新验签器应在缺失时拒绝验签。

本机没有测试设备验证密钥/固件验证器（用户本轮已确认“无”）。真实驱动只能发送 RECEIVED，并回读管理 API；不会发送 VERIFIED，不会用 SQL 播种 Active。本地已知测试密钥验证规范载荷，不等价于真实设备独立验签；目标 Licensed→Active 保留 NOT RUN。

## 数据链路观测

固定 JSON 日志包含 Lambda/Gateway requestId、operationId、SQS messageId、设备 messageId/seq、deviceId/topicType、broker receivedAtMs、事件 occurredAtMs、coldStart、阶段、startedAt/completedAt、durationMs、结果及有限错误码。身份与载荷校验前只有 Lambda/SQS 关联信息；控制台归属校验前不记录设备 ID。没有 Payload、Token、Secret、原始异常文本或 SQL；日志传输失败不改变业务结果或重试语义。

阶段覆盖 envelope、identity、payload-validation、db-transaction、事务回调、锁、分配、receipt、business、outbox/gap、Telemetry 聚合/归档 Outbox，以及 console 设备、最新状态、最新小时选择、跨站点桶、耗材/告警/合约/ESG/media 查询与 response-serialize。

`ingestion.receipt.completed` 在 processWithReceipt 返回处记录；根事务仅在驱动成功完成事务后标记 ROOT_TRANSACTION_COMPLETED，嵌套调用标记 ENCLOSING_TRANSACTION_CALLBACK_ONLY，外层仍可能回滚。`ingestion.record.completed` 是具体 SQS 记录业务分发结束，不代表 S3 已归档；重投必须同时匹配特定 SQS ID、设备事件 ID、原 receiptId、DUPLICATE_SKIPPED 和最终 PROCESSED。仅数据库行数未增长、PUBACK 或提交成功均不够。

`includesConnectionWait=true` 表示调用耗时可能包含连接等待，**没有测得纯连接池等待时长**。外层事务与回调的差值混合 BEGIN/COMMIT、调度和未分类等待，不能直接归因于池。控制台并行查询可能共用 pool1 排队，嵌套/并行阶段不可相加当总耗时。阶段 duration 使用单调时钟，事件与 broker 时间跨时钟只能辅助诊断。原 receipt.processedAt 仍是创建时点，不能作为事务提交时点。coldStart 表示整个 Lambda 调用是否初始化运行时。

## 新版本复验与部署边界

1. 完成本地提交，人工 GitHub Desktop 推送；等待同 SHA CI、Deploy test environment、Amplify 完成。沿用已授权测试应用部署通道，不创建 IAM/KMS 补丁，不改变权限。若工作流出现权限差异，停止变更并保留失败回执交运维处理。
2. 设置完整40位 `QA09_EXPECTED_COMMIT` 与成功部署 `QA09_DEPLOY_RUN_ID`；使用 `collect-qa09-application-version.mjs` 核对19个不可变 Lambda 工件字节、源版本与运行时摘要。回执必须 PASS，再创建新前缀夹具。新代码需要 API、Device API、Ingestion 三个入口，其他共享观测导出带来的工件变化也按19项统一核对。
3. 首选无前置 quick 突发的专项：

```sh
node scripts/collect-qa09-application-version.mjs <version.json>
node --import tsx scripts/run-qa09-normal-slo-target.mjs <normal.json> <version.json>
node scripts/qa09-data-path-evidence.mjs <normal.json.probes.json> <version.json> <stages.json>
```

运行前按上一轮部署材料设置同 SHA/Run，必要时 `QA09_CODE_RANGE_TIMEOUT_MS=180000`。normal 驱动会创建本轮十设备与客户、领取设备证书、真实 MQTT 基线、建立自有站点/分配、测试20条 Telemetry 与20条在线 Command，并在许可证 issue/activate 后执行 RECEIVED 和管理员回读。阶段采集仅使用只读 profile、固定账号/区域、已核对的 API/Ingestion 日志组、最长6小时窗口及最多20页，不归档原始日志文本。日志缺失、迟到、窗口截断均不能 PASS，可等待日志到齐后用同回执再采集。
4. 分别报告 Assigned→Licensed 的真实确认、独立 HMAC/Active NOT RUN、Telemetry 可见 P95≤5000ms、Command P95≤3000ms、各序号阶段覆盖、S3/唯一性和清理。完整 quick 实际速率另用 continuation 驱动，不把 normal 的20样本当全负载。特定队列重投依赖管理员维护的现有权限；被拒绝时记录 BLOCKED，不调整 Key policy、不读取或清空共享队列。
5. 结束前保存基线设备/证书摘要，精确清理本轮业务/身份/客户/设备及所有归档版本，核对独立闭环。最后再收集 runtime-only 版本回执；代码/Revision 漂移时本次结果失效。

只读日志采集器的 PASS_SCOPED_STAGE_EVIDENCE 仅证明本轮20序号阶段覆盖和至少一个控制台查询被观测，不证明性能达标、所有API/日志路径覆盖或完整 QA-09。八套正式领域证据仍须各自 Gate。

## 回滚

本轮没有 IaC、数据库 Schema 或容量修改。沿用 API/Ingestion pool1、Device API 既有 pool2 与统一63/70预算，余量7；不得因日志推断自行扩容。回滚到此前已核对的应用 SHA，并重新核对19工件；旧服务会拒绝新 licenseConfirmation，因此设备/验收驱动需停止新确认请求、恢复旧 Sync 请求。新字段不能强制旧设备接受。已写 Licensed/Active 状态和审计不会随代码回滚自动逆转，必须按合法领域操作处理，不直接批量改状态或删审计。保留原失败样本和所有版本回执。
