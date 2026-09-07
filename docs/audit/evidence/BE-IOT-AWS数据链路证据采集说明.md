# BE-IOT-01 / QA-03 目标 AWS 数据链路证据采集说明

## 目的与 Gate

本目录只接收隔离 AWS 环境实跑生成的证据回执。CDK synth、本地单元/集成测试和人工勾选不能替代目标环境证据。

独立发布 Gate：

```bash
pnpm check:aws-iot-evidence
```

默认读取 `docs/audit/evidence/be-iot-aws-data-path.json`。也可通过 `FDP_AWS_IOT_DATA_PATH_RECEIPT` 指向受控流水线下载的回执。缺少回执、`sourceCommit` 与当前 `HEAD` 不一致、字段不全、任一探针未通过或清理未完成时，Gate 必须返回非零。

该云端 Gate 不加入日常 `pnpm verify`：普通开发机没有目标账号权限时仍可执行本地质量门禁，但发布决策必须额外执行本 Gate。

## 采集前提

- 仅使用明确标识的隔离测试账号和已部署的目标提交；禁止在生产账号做故障注入。
- 记录 `sourceCommit`、UTC `executedAt`、AWS Account、Region、Stack 名称。
- 证据引用使用 AWS request ID、SQS message ID、数据库业务 ID、S3 对象 Key、CloudWatch Logs Insights 查询 ID或受控流水线制品路径；不得写入证书私钥、Token、数据库密码或其他敏感材料。
- Error Action 故障注入必须有审批、精确目标、恢复步骤和恢复证据。

## 必须覆盖的探针

1. `heartbeat/telemetry/report/alarm/event/ack/tamper/media` 八个精确 Topic 均真实发布并到达同一 Ingress；逐条记录发布原文和 Ingress 原文 SHA-256，二者必须一致。
2. 发布一个未知 Topic，持续观察至少 60 秒，Ingress 新增消息必须为零。
3. 对临时测试 Rule 注入 Action 失败，确认独立 Rule Error Queue 收到消息，并确认权限/Rule 已恢复。
4. QA-03 链路逐项留证：partial batch failure、Quarantine、receipt、RDS、outbox、Archive SQS、S3 Raw Archive。
5. S3 归档记录的 `rawBody` 与源消息逐字符计算 SHA-256，必须一致。
6. 删除临时 Thing/证书/Policy/测试 Rule/消息和故障注入配置；回执 `cleanup.completed=true`。

## 回执结构

回执由受控集成测试流水线生成，结构由 `scripts/check-aws-iot-data-path-evidence.mjs` 执行校验。所有 probe 至少包含：

```json
{
  "passed": true,
  "evidence": ["aws-request-id-or-controlled-artifact-reference"]
}
```

八类路由还必须包含 `type`、`deviceId`、精确 `topic`、`publishedBodySha256`、`ingressBodySha256`；未知 Topic 必须包含 `observedSeconds` 与 `ingressMessages`；Error Action 必须包含 `restored`；S3 原文验证必须包含 `sourceRawBodySha256` 与 `archivedRawBodySha256`。

当前仓库未提交 PASS 回执时，M-06 保持 OPEN，BE-IOT-01 只能是 CONDITIONAL。
