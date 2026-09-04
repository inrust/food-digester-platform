# DEC-015 OTA 状态回传通道

## 冻结结论

DEC-015@1.0.0 选择方案 A：设备沿用 `bnx/device/{deviceId}/ack` 回传 OTA Target 状态。Topic Catalog 保持 8 个上行、3 个下行；IoT 单设备策略仍只需允许设备发布自身 ACK，无新增权限面，也不采用 AWS IoT Jobs 状态事件。

ACK 采用强制判别字段：

| objectType | 关联键 | 业务字段 |
|---|---|---|
| `COMMAND` | `commandId` | `command`、`result`、`executeTimeMs` |
| `OTA_TARGET` | `otaTargetId` | `status`、`errorCode`、`message` |

两类关联字段禁止混用。OTA 状态仅允许 `DOWNLOADING`、`INSTALLING`、`SUCCEEDED`、`FAILED`、`ROLLED_BACK`。

## 状态与安全规则

- `NOTIFIED → DOWNLOADING → INSTALLING → SUCCEEDED` 为正常路径；各活动阶段可进入 `FAILED`，安装或成功后可进入 `ROLLED_BACK`。
- 相同 Target、相同状态的新消息作为事件记录但不重复迁移；相同 `{deviceId}:ack:{meta.seq}` 和相同载荷完全跳过。
- 越级、回退、未知 Target、跨设备 Target 或 COMMAND/OTA 字段混用均进入隔离，不修改业务状态。
- OTA Target 状态、历史和 `ota.status.ack` 审计在同一事务写入。
- DEC-016 尚未冻结，因此 OTA 结果不伪装成设备上行原文归档；独立归档 Envelope 留待 DEC-016。

## 证据

- 冻结策略：`contracts/mqtt/ota-status-channel-policy.json`
- 线协议：`contracts/mqtt/schemas/ack.schema.json`
- 接收实现：`apps/ingestion-worker/src/signals/ack.ts`
- 集成测试：`apps/ingestion-worker/test/ota-status-ack.test.ts`
