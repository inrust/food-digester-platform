# BE-CUS-01/02、BE-DEV-01～06 目标 AWS 验收证据采集说明

## 目的与 Gate

本说明用于在已授权、可清理的隔离 AWS 环境采集 8 项管理后台后端任务的真实运行回执。本地 PGlite、mock、OpenAPI 校验和 CDK synth 均不能替代该回执。

```bash
pnpm check:aws-admin-evidence
```

Gate 默认读取 `docs/audit/evidence/be-cus-dev-aws-acceptance.json`；受控流水线可用 `FDP_AWS_ADMIN_CUS_DEV_RECEIPT` 指向下载的回执。缺文件、结构不完整、任一探针失败、`sourceCommit` 与当前 `HEAD` 不一致或清理未完成时返回非零。该 Gate 不加入普通开发机 `pnpm verify`，但属于严格验收和发布必跑 Gate。

## 授权与安全边界

- 仅在明确授权的隔离测试账号执行，不在生产账号做并发、跨租户或故障注入。
- 回执必须记录精确 Git SHA、UTC 时间、Account、Region、Stack 和实际 API Base URL。
- Evidence 只记录 API Gateway/Lambda/AWS IoT/S3 请求 ID、CloudWatch 查询 ID、资源 ARN/Key、测试数据 ID及受控流水线制品引用；禁止写入 JWT、数据库口令、证书私钥、完整 PEM、预签名 URL 查询参数或客户敏感正文。
- 全部临时身份、设备、Customer、Site、S3 对象和故障注入必须在 `cleanup` 中证明已恢复或删除。

## 必须覆盖的探针

1. `apiOperations`：25 个 CUS/DEV operationId 必须无重复完整覆盖；每项包含真实成功状态、至少一个负向状态、API request ID 和证据引用。
2. `rbac.roles`：PlatformSuperAdmin、PlatformOperator、Auditor、CustomerAdmin、CustomerViewer 五角色均有允许/拒绝矩阵证据；`crossCustomer` 必须返回 403 或 404。
3. `ifMatchRace`：同一版本并发写入恰好一条成功、一条 409，最终 DB 值和审计与胜出请求一致。
4. `retirement`：真实 AWS IoT Certificate 状态为 `INACTIVE`；Heartbeat、Telemetry、Report、Alarm、Event、ACK、Tamper、Media 八类退役后上行均不得进入业务处理。
5. `activityExport`：API→Worker→S3→短期下载链路可用；创建时间后的行不进入快照，设备转租户后旧租户返回 403/404，URL 过期后 `downloadUrl=null` 且 `urlExpired=true`。
6. `cleanup.completed=true`：测试资源、对象、身份和故障注入均已清理或恢复。

## 回执最小形状

每个 probe 至少包含 `passed: true` 和非空 `evidence`。完整字段及精确约束由 [`check-aws-admin-cus-dev-evidence.mjs`](../../../scripts/check-aws-admin-cus-dev-evidence.mjs) 强制：

```json
{
  "schemaVersion": "1.0",
  "status": "PASS",
  "sourceCommit": "40-character-lowercase-git-sha",
  "executedAt": "2026-09-08T11:00:00Z",
  "environment": {
    "isolated": true,
    "accountId": "123456789012",
    "region": "ap-southeast-1",
    "stackName": "fdp-test",
    "apiBaseUrl": "https://example.execute-api.ap-southeast-1.amazonaws.com/"
  },
  "probes": {
    "apiOperations": [],
    "rbac": { "roles": [], "crossCustomer": {} },
    "ifMatchRace": {},
    "retirement": { "mqttDenied": [] },
    "activityExport": {}
  },
  "cleanup": { "passed": true, "completed": true, "evidence": ["controlled-cleanup-reference"] }
}
```

当前没有与待发布提交匹配的真实 PASS 回执时，目标 AWS 验收必须保持 `NOT RUN / OPEN`，不得提交占位 PASS 文件。
