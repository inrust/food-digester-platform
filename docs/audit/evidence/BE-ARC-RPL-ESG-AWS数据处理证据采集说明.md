# BE-ARC/RPL/ESG 目标 AWS 数据处理证据采集说明

## 目的与 Gate

本说明用于采集 BE-ARC-01、BE-ARC-02、BE-RPL-01、BE-ESG-01 的隔离 AWS 环境实跑回执。日常 `pnpm verify`、PGlite、mock、CDK synth 和人工勾选均不能替代该证据。

```bash
pnpm check:aws-data-processing-evidence
```

Gate 默认读取 `docs/audit/evidence/be-arc-rpl-esg-aws-data-processing.json`；受控流水线可通过 `FDP_AWS_DATA_PROCESSING_RECEIPT` 指向下载的回执。缺文件、字段不全、任一探针失败、`sourceCommit` 与当前 `HEAD` 不一致或清理未完成时必须返回非零。该 Gate 不加入普通开发机的 `pnpm verify`，但属于发布与严格验收的必跑 Gate。

## 前提和禁止事项

- 仅在明确授权、可清理的隔离测试账号执行；生产账号不得做重复投递或失败注入。
- 部署回执所声明的精确 `sourceCommit`，记录 UTC 时间、Account、Region 和 Stack。
- Evidence 引用 AWS request ID、SQS message ID、Lambda request ID、CloudWatch 查询 ID、S3 Key/Version ID、数据库业务 ID或受控流水线制品；不得记录 Token、数据库口令、证书私钥或消息敏感正文。
- 任何故障注入都必须限定测试资源，并在 `cleanup` 中记录恢复与删除证据。

## 必须覆盖的探针

1. `archive.outbox`：业务记录与 ARCHIVE Outbox 同事务提交；Archive Publisher 不领取 Notification。
2. `archive.archiveQueue`、`s3Object`、`manifest`：EventBridge 触发 Publisher，SQS 触发 Archive Lambda，S3 对象与 Manifest 可读取；对象 SHA-256 与 Manifest 一致。
3. `archive.duplicateDelivery`：同一 eventId 至少投递两次，`logicalRecordCount=1`。
4. `archive.partialFailure`：同批至少一条失败和一条成功，失败记录可重试且成功记录不回滚。
5. `replay.apiCreate`、`triggerQueue`、`worker`：真实 API 创建 Job，经 Outbox/SQS 触发 Worker，读取 S3 并投入 Ingress，数据库终态与审计一致。
6. `replay.idempotency`：重放已处理消息后 `duplicateBusinessRows=0`；`outOfScope` 证明范围外记录未投入 Ingress。
7. `summary.scheduleInvocation`、`migration`：目标 PostgreSQL Migration 成功且 EventBridge 实际触发 Summary Lambda。
8. `summary.hourly`、`daily`、`esgDaily`：三种结果均有正整数 `rowCount`，并留存 event time、Customer/Site、完整率和缺失数的查询证据。
9. `cleanup.completed=true`：恢复故障注入并清除临时数据/资源。

## 回执最小形状

每个 probe 至少包含 `passed: true` 与非空 `evidence`。额外必填字段由 [校验器](../../../scripts/check-aws-data-processing-evidence.mjs) 强制：

```json
{
  "schemaVersion": "1.0",
  "status": "PASS",
  "sourceCommit": "40-character-lowercase-git-sha",
  "executedAt": "2026-09-08T10:00:00Z",
  "environment": {
    "isolated": true,
    "accountId": "123456789012",
    "region": "ap-southeast-1",
    "stackName": "fdp-test"
  },
  "probes": {
    "archive": {},
    "replay": {},
    "summary": {}
  },
  "cleanup": {
    "passed": true,
    "completed": true,
    "evidence": ["controlled-cleanup-reference"]
  }
}
```

当前未提交与待发布提交匹配的 PASS 回执时，四项任务的目标 AWS 验收保持 `NOT RUN / OPEN`，不得改写为生产验收完成。
