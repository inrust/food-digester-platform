# QA-09 Gateway welcome 验证精确补充方案（待确认）

2026-10-03，目标账号 065986019555、区域 ap-southeast-1。当前应用源码 7c6f356 的 CI/默认部署成功；观测性三次部署均回滚，容量/即时发布尚未执行。

## 真实原因与已有状态

CloudTrail 事件 `123469d7-f136-454b-ac39-87ce10cd05c0`（09:18:37 UTC）证明：API Gateway 的 BackplaneAssumeRoleSession 创建 `/aws/apigateway/welcome` 被身份策略拒绝。仅补 CreateLogGroup 后，第三次实际事件 `165cc9eb-7286-4614-a96b-6cfbe9cae95d` 的创建检查返回 AlreadyExists，随后 `5ca6781a-cd77-4692-8e41-e5616e38cdc6`（09:40:31 UTC）的 DescribeLogStreams 再被身份策略拒绝；见[第三次原始回执](evidence/qa-09-phased-deployment-2026-10-03/gateway-attempt3-cloudtrail-own-role.json)。这确认 AWS 校验涉及固定系统组的后续日志动作，单独创建权限不足。

AWS 文档列出创建组/流、枚举组/流、读写事件等所需动作，参见[官方日志配置](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-logging.html)与[动作列表](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonAPIGatewayPushToCloudWatchLogs.html)。补充方案采用两个精确组，不挂全日志组的 AWS 管理策略；具体后续动作仍以真实校验为准。

实际 ServiceBoundary 当前默认 v6，原 v3/v5 保留。日志组 `/aws/apigateway/fdp-test-admin-api-access` 和 KMS Key 5f69dab9-0b1c-4c18-b7f4-926174c3207b 在首次回滚时被 RETAIN，已通过仅两个 IMPORT 动作接管，未删除。后续回滚不再遗留这些资源。v7 welcome 扩展被自动审批审查拒绝，未执行。

## 推荐：仅本轮临时验证权限

唯一角色：`arn:aws:iam::065986019555:role/fdp-test-admin-gateway-logs-role`，信任主体仅 apigateway.amazonaws.com。新增资源仅系统组 `/aws/apigateway/welcome`（组及组内流的两种精确 ARN）；应用日志仍唯一主组，dataTrace/execution logging 关闭。

临时角色动作：CreateLogGroup/CreateLogStream/DescribeLogStreams/PutLogEvents/GetLogEvents/FilterLogEvents；Boundary 只追加其中原边界未覆盖的 DescribeLogStreams/GetLogEvents/FilterLogEvents，ArnEquals 仅上述角色。到期 UTC 2026-10-03T13:00:00Z（北京时间 21:00），校验成功后提前撤销 welcome 新增读取/写事件权限，保留已批准的 CreateLogGroup。主组 ARN 同时覆盖组和流格式。保留原 v3，清理本轮不再使用的非默认候选 v5/v6 必须先保存完整文档与摘要，不删除历史 v2/v3。

可审阅 JSON：[角色新增](evidence/qa-09-phased-deployment-2026-10-03/proposed-temporary-welcome-role-addition.json)、[临时边界候选](evidence/qa-09-phased-deployment-2026-10-03/proposed-temporary-boundary-not-applied.json)。未应用。

通过既有 CloudFormation 执行角色更新唯一日志角色，SSO 合并指定边界版本；不新增人类 PassRole 权限、不改其他角色的有效权限、不读取生产凭据或 CA Secret 值、不修改 CA/设备/证书。成功后完成日志逐请求关联，继续 capacity/immediate 部署与同版本真实业务复验。未来若重建 Gateway Account/日志角色，需再次在操作窗口启用固定系统组验证权限；通常保持同一 Account/角色的配置更新不会重新创建该资源，仍以实际 diff/执行为准。

另一可选授权是永久保留相同精确系统组权限，以支持未来 Account 重建；仍只限同一 Gateway 服务角色及两组。未经明确选择，不能默认执行永久扩展。

## Gate 与 CA 前置

完整 QA-09 PARTIAL，本阶段 BLOCKED_PENDING_EXPLICIT_SCOPE_AUTHORIZATION。旧方案只授权主业务日志组，本轮 welcome 权限超出该资源范围，自动审批明确拒绝持久扩展，因此需要追加确认。

Worker CA 的身份策略模拟为 implicitDeny，但该模拟没有合并 KMS Key Policy 的指定 Worker ViaService 直授；当前 Key Policy 存在直授，不能仅凭身份模拟宣称真实解密失败。Secret/Key 绑定和 AWSCURRENT/AWSPREVIOUS 保持，尚未追加 CA 权限或读取 Secret 值。新 CSR 实测若失败，再以真实拒绝决定精确处置。

## 补充授权与实施状态

用户已明确选择临时开放、验证后撤销。含到期条件的 v7 已于 10:10:28 UTC 应用，原 v3/v6 保存；第四次 observability 更新执行中。此前拒绝和三次失败记录保留，不能把待执行复验视为 PASS。

## 最终执行状态（2026-10-03）

三阶段及指定Command消费者的精确Key Policy修复已部署成功；welcome临时扩展已撤销，Boundary默认v8，原v2/v3保留，自有非默认v5/v6/v7归档后删除。原Key全部语句和CA Secret版本元数据保持。修复后在线Command20/20收到、消费者20条PUBLISHED，但P95 7507ms仍FAIL；Telemetry12/20可见及归档积压FAIL保留。三轮夹具及域归档清理全部PASS。前文的待确认/执行中描述属于历史过程，当前状态以[最终执行记录](QA-09-分阶段部署与真实复验执行记录-2026-10-03.md)为准；完整QA-09仍PARTIAL。
