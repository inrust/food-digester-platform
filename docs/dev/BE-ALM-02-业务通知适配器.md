# BE-ALM-02 业务通知适配器

实现：[apps/cloud-api/src/notification/business-notifier.ts](../../apps/cloud-api/src/notification/business-notifier.ts)；生产侧领域事件：[apps/ingestion-worker/src/signals/archive.ts](../../apps/ingestion-worker/src/signals/archive.ts)（`writeCriticalAlertOutbox`）+ alarm/tamper Handler 接线；验收测试：[business-notifier.test.ts](../../apps/cloud-api/test/business-notifier.test.ts)+ [signals-handlers.test.ts](../../apps/ingestion-worker/test/signals-handlers.test.ts)。

> 当前状态：延期。领域事件、数据库模型和纯业务模块保留；SES/Webhook 发送适配器、Lambda 调度、部署配置及目标 AWS 通知 Gate 已移除。后续有明确需求时重新立项，并重新定义外部发送配置与验收回执。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ALM-02（延期）；当前不部署邮件/Webhook 发送能力 |
| 事件来源（封闭集合） | `CRITICAL_ALERT_RAISED`（BE-IOT-07 生产侧：CRITICAL Alarm 激活 / CRITICAL Tamper，与业务行同事务落库 Outbox）；`ALARM_STATE_CHANGED`（BE-ALM-01：CRITICAL 告警确认/清除真实迁移） |
| 功能边界 | 仅设备业务告警；不处理 SQS/RDS/Lambda 等运维告警 |

## 2. 关键设计

**存储**（migration `20260830110000_business_notifications`）：
- `customer_notification_configs`：每 Customer 一行（customerId 唯一）：enabled、emailRecipients、webhookUrl；
- `notification_deliveries`：`idempotency_key`（`eventId:channel:target`）唯一索引 = 幂等键；status PENDING/SENT/FAILED + retryCount/lastError/sentAt 保存发送状态。

**派发**（`dispatchPendingNotifications`）：扫描 PENDING/PUBLISHED 领域事件（按 createdAt，批量上限）→ 防御性 severity 校验（非 CRITICAL 跳过，不产生投递）→ 按事件 customerId 查配置（无配置/停用/无目标 → 抑制）→ 白名单渲染 → 幂等创建投递记录（P2002 → 跳过不重发）→ 立即尝试发送（成功 SENT + sentAt；失败 FAILED + lastError + retryCount）。

**重试**（`retryFailedDeliveries`）：仅 FAILED 且 retryCount < maxAttempts（默认 5）；SENT 终态永不重发——重试不重复通知。

**内容安全**：通知内容白名单渲染（kind/code/category/message/eventType/状态迁移/deviceId/customerId/occurredAt），不透传原始报文全文；渲染结果再做敏感模式（password/secret/privateKey/token/verifier 等）fail-closed 检查（`NotificationError SENSITIVE_CONTENT`）。

**当前边界**：`EmailSender`/`WebhookSender` 领域端口及通知记录模型保留，但没有 AWS 发送适配器、生产 Composition Root 或 EventBridge 调度。

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| Critical 生成通知记录 | CRITICAL Alarm 激活 → 邮件×2 + Webhook×1 全部 SENT（含 sentAt/幂等键断言）；Tamper 与 ALARM_STATE_CHANGED 同样产生通知 | ✅ |
| 非 Critical 不发送 | severity=MAJOR 事件 / 无配置 / 停用配置 → 0 投递记录、发送端口零调用 | ✅ |
| 重复事件只有一次有效通知 | 重复派发 → created=0、幂等键 P2002 跳过、邮件仍仅 1 封、投递记录仅 1 条 | ✅ |
| 重试不重复通知 | 双通道失败 → FAILED(retryCount=1,lastError)；恢复后重试 2 条全转 SENT；SENT 后再重试/派发不触达发送端口；持续失败递增至 maxAttempts 后停止 | ✅ |
| 通知内容不含敏感凭据 | 非白名单字段（privateKey/verifier）不进入渲染结果；白名单字段命中敏感模式 fail-closed 抛错 | ✅ |
| 生产侧领域事件 | CRITICAL Alarm 激活产出 `CRITICAL_ALERT_RAISED`（kind=alarm、白名单载荷）；非 CRITICAL 不产出；CRITICAL Tamper 产出 kind=tamper | ✅ |
| 无 AWS 依赖 | 模块源码扫描无 @aws-sdk/@fdp/aws-clients | ✅ |

## 4. 未决风险

- SES/Webhook 重新立项前不要求生产调度、提供商请求 ID 或目标 AWS 通知回执；
- 通知配置暂无管理 API（测试直接落库）；如需后台维护 Customer 通知配置，需新任务定义 CRUD 与权限；
- FAILED 超过 maxAttempts 后无告警通道（死信观察依赖运维侧，属边界外）；
- Outbox 扫描不按事件去重游标推进，依赖投递幂等键兜底（事件量增长后可加 lastScannedAt 水位线优化）。
