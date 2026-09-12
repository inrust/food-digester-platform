# BE-LIC/CON/CFG/CNS/DUSR/ALM/ESG 目标 AWS 验收证据采集说明

## 1. 发布判定

本地测试、mock、CDK synth 与 Composition Root 单测只证明仓库内实现，不证明目标 AWS 已部署并可用。正式发布前必须在隔离 AWS 环境生成 `docs/audit/evidence/be-admin-business-aws-acceptance.json`，并执行：

```bash
pnpm check:aws-admin-business-evidence
```

回执缺失、字段缺失、探针失败或 `sourceCommit` 与 `git rev-parse HEAD` 不一致时 Gate 必须失败关闭。该独立发布 Gate 不并入本地 `pnpm verify`，避免日常开发伪造云端 PASS。

## 2. 必需探针

- 以真实 Cognito token 覆盖 58 个正式 API operation（含 `listLicenses` 与按需联系人 `getConsumableContact`）；每项保存成功状态、请求 ID、401 和至少一个其他负向状态。
- `getConsumableContact` 额外保存未授权 403、跨 Customer/不存在设备 404，以及列表响应、浏览器网络记录、DOM 和应用日志中未点击前均无联系人号码的证据。
- 覆盖 PlatformSuperAdmin、PlatformOperator、Auditor、CustomerAdmin、CustomerViewer 五角色，并证明跨 Customer 返回 403/404。
- 对带 `If-Match` 的写接口发起同版本并发请求，必须恰好一项成功、一项 409。
- EventBridge 调度间隔不超过 1 分钟；通知链路必须证明 PROCESSING 抢占、并发仅发送一次、SES v2/Webhook HTTPS allowlist 的提供商请求 ID与失败重试恢复。
- ESG 导出必须证明查询与 CSV 行数一致、S3 key 使用 `esg-exports/`、跨租户拒绝、短期 URL 到期不可用、生命周期不超过 1 天，以及过期 PROCESSING 任务可恢复。
- 清理所有测试用户、设备、合同、通知、导出对象及临时配置，并保存清理证据。

## 3. 回执边界

回执仅对其 `sourceCommit`、账号、区域、Stack 与执行时刻有效。敏感 token、密码、签名密钥和完整业务数据不得写入仓库；`evidence` 字段只保存 CloudWatch/X-Ray/S3/测试流水线等可审查引用。未取得真实回执时，状态必须记录为 `NOT RUN / OPEN`，不得复制示例或手工声明 `PASS`。
