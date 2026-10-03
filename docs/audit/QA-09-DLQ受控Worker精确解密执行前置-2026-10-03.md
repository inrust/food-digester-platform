# QA-09 DLQ 受控 Worker 精确解密执行前置

当前状态：**BLOCKED，消息未删除，临时 Key 权限未开放**。本轮用户要求 DLQ 精确处置；20 条残留不能凭计数视为自有。AWS 内只读通道已证明旧前缀 `qa09-c6b8375015168915` 的20个命令及 `COMMAND_PUBLISH_REQUESTED` Outbox 均不存在，原设备2/证书3摘要保持。接收消息仍需逐条核对该闭环 ledger。

## 实际阻断与已清理的尝试

SSO 接收指定 DLQ 返回 KmsAccessDenied，未取得正文或 ReceiptHandle、未删除。CloudTrail 同窗口确认对 DataKey `22af85c4-76d3-40c9-a849-0621740afe6c` 没有资源策略允许 kms:Decrypt；请求参数为空，因此不能将该事件本身声称为独立的队列上下文证明。拒绝事件只保留 principalArn/type，移除 accessKeyId。

只读模拟当前 FDP-InfraSetup：指定 Command Worker 的 PutRolePolicy/DeleteRolePolicy、PassRole→lambda.amazonaws.com，以及固定诊断函数 Create/Invoke/Delete 为 allowed；直接 PutKeyPolicy 为 explicitDeny。模拟不替代真实资源策略。一次仅新增 Key 语句的 CloudFormation 变更集列出41项依赖传播，包括RDS与事件源Conditional，触发单资源执行保护，**没有 ExecuteChangeSet**。自有变更集及唯一模板上传版本已删除；Key临时Sid不存在，栈保持 UPDATE_COMPLETE。没有绕过此保护执行更新。

## 运营所需的最小动作

优先由**现有该 Key 管理通道**临时追加以下唯一语句；不需要授予 SSO 人类 Decrypt，不改 Secret/CA/队列属性或其他主体。若必须让 SSO 管理写入，需要对唯一 Key 的 PutKeyPolicy 临时例外并同步处理现有 explicitDeny；单独增加 Allow 不会覆盖显式 Deny。该管理授权尚未获得，不能由本任务自行改 Permission Set。

- Key：`arn:aws:kms:ap-southeast-1:065986019555:key/22af85c4-76d3-40c9-a849-0621740afe6c`
- Principal条件：`arn:aws:iam::065986019555:role/fdp-test-command-publisher-role`
- Action：仅 `kms:Decrypt`；Key Policy 的 Resource `*` 仅表示该 Key 自身。
- ViaService：`sqs.ap-southeast-1.amazonaws.com`
- 加密上下文：`arn:aws:sqs:ap-southeast-1:065986019555:fdp-test-command-publish-dlq`
- Sid：`Qa09CommandDlqDiagnosticDecrypt`；DateLessThan须固定短期UTC截止时间，实施前核对未过期，不自动续期。

可审阅的完整语句：[精确 JSON](evidence/qa-09-performance-remediation-2026-10-03/dlq-key-temporary-exact-addition.json)。其中 `2026-10-03T14:35:41Z`（北京时间22:35:41）属于本轮**未执行的历史候选**；若届时已过期，先重新确认短期截止时间，再生成新的回执，不能直接应用旧文件。原 Main Queue 的解密语句保持；[AWS消费者权限说明](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-key-management.html)要求DLQ消费者同时拥有消息来源Key的解密授权，本轮Main/DLQ为同一DataKey。

SSO可在已授权任务内为上述 Worker 加入一份独有临时 inline：仅指定DLQ的 GetQueueAttributes/ReceiveMessage/DeleteMessage/ChangeMessageVisibility，附同一到期条件。既有Worker的DataKey身份解密授权保持，不扩大人类权限。PassRole仅该角色到lambda.amazonaws.com。一次性函数固定 `fdp-test-qa09-command-dlq-diagnostic`，复用原Command日志组，不创建队列事件源、不自动消费、不调用IoT、不连接DB。

## 受控执行与撤销

1. 新跑 `command-dlq-readonly`，核对源码/Build/只读证明、闭环业务/设备ledger；不得用旧恢复日志替代当前状态。`closedCommandLedger`要求20个精确ID、十设备数据库清理及业务清理PASS、当前命令/Outbox均为空。
2. 部署只读证明SHA/前缀/≤5分钟有效期绑定的一次性Worker，校验ZIP CodeSha256、Role和不可变Version1。执行源为 `scripts/qa09-command-dlq-worker.mjs`、`qa09-command-dlq-scope.mjs`；已测试未知内容保留、过期证明拒绝和不输出正文/ReceiptHandle。
3. 最多4页、每页10条；只有正文恰为 `{commandId}` 且ID在20条允许列表内才Delete。未知内容仅记录摘要、恢复Visibility=0并停止继续翻页；不Purge、不Redrive、不改主队列。
4. 保存逐条摘要/Disposition及最终可见/在途计数。部分失败保留PARTIAL/BLOCKED，不以收到20条或删除部分条数报PASS。
5. 删除仅自有诊断函数/临时inline，核对原inline策略全文保持；Key管理方从**最新**策略中仅删除该Sid，保留其他并发更改及原全部语句。再核验Sid不存在/CA元数据保持。不能以到期替代撤销回执。

本轮已准备受控执行器 [源快照](evidence/qa-09-performance-remediation-2026-10-03/dlq-service-worker-executor.py)，因Key前置未落地尚未运行。该执行器以新只读证明进行20条闭环验证，绑定5分钟能力、校验函数版本并在finally撤销自有函数/inline。Key语句由原管理通道负责追加/撤销，不能直接运行已触发保护的CF执行器。
