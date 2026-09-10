# BE-MED/RBAC/AUD/DASH/SET 目标 AWS 验收证据采集说明

## 1. 发布判定

本地测试、PGlite、fake Cognito/S3、组合根测试和 CDK synth 只证明仓库内实现与接线，不证明目标 AWS 已部署。正式发布前必须在隔离 AWS 环境生成 `docs/audit/evidence/be-med-rbac-aud-dash-set-aws-acceptance.json`，并执行：

```bash
pnpm check:aws-med-rbac-aud-dash-set-evidence
```

回执缺失、字段缺失、探针失败或 `sourceCommit` 与 `git rev-parse HEAD` 不一致时 Gate 必须失败关闭。该发布 Gate 不并入本地 `pnpm verify`，避免日常开发用模拟结果伪造云端 PASS。

## 2. 必需探针

- 用真实 Device mTLS 与 Cognito JWT 覆盖六份正式 OpenAPI 的 15 个 operation；每项保存成功状态、requestId、401 和至少一个其他失败状态。
- 覆盖五角色与跨 Customer 拒绝；邀请、Groups 整体同步、`custom:customer_id`、Disable、Password Reset 与一次确定性补偿必须在真实 Cognito 可观察。
- 两个 SuperAdmin 并发互降以及停用/降级并发必须一成功一冲突，最终至少保留一个有效 SuperAdmin；Settings 同版本并发必须一成功一 409。
- Media 必须证明服务端生成 Key、Content-Length 与 SHA-256 签名绑定、上传后 Hash 复核、DEC-024 的上传/下载 900 秒 TTL 及过期拒绝；101 个并发配额请求只能签发 100 个会话。
- Dashboard 必须覆盖有效 REMOTE_CONTROL、无 License、过期、吊销和无 Entitlement；审计读回不得泄露 Authorization、Cookie/Set-Cookie、Session、JWT 或 access/refresh/id token。
- 未知字段、数组 body 和邀请 `password` 必须在 Cognito、S3、DB 与审计副作用前返回 400。
- 清理测试用户、设备、License、Media 对象、设置变更和临时身份，并保存可审查清理引用。

## 3. 回执边界

回执仅对其 `sourceCommit`、账号、区域、Stack、User Pool、Media Bucket 与执行时刻有效。凭据、JWT、Cookie、临时密码、签名 URL 和业务原文不得写入仓库；`evidence` 只保存 CloudWatch/X-Ray/测试流水线等可审查引用。真实回执尚未生成时必须保持 `NOT RUN / OPEN`。
