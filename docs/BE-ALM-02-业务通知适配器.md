# BE-ALM-02 业务通知适配器

实现：[apps/cloud-api/src/notification/business-notifier.ts](../apps/cloud-api/src/notification/business-notifier.ts)；生产侧领域事件：[apps/ingestion-worker/src/signals/archive.ts](../apps/ingestion-worker/src/signals/archive.ts)（`writeCriticalAlertOutbox`）+ alarm/tamper Handler 接线；验收测试：[business-notifier.test.ts](../apps/cloud-api/test/business-notifier.test.ts)（8 项）+ [signals-handlers.test.ts](../apps/ingestion-worker/test/signals-handlers.test.ts)（新增 2 项生产侧断言）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ALM-02（P2 / 后端业务），依赖 BE-ALM-01（已交付）、IAC-01（SES/Webhook 发送端口与调度由部署层接线，本任务不依赖其落地） |
| 事件来源（封闭集合） | `CRITICAL_ALERT_RAISED`（BE-IOT-07 生产侧：CRITICAL Alarm 激活 / CRITICAL Tamper，与业务行同事务落库 Outbox）；`ALARM_STATE_CHANGED`（BE-ALM-01：CRITICAL 告警确认/清除真实迁移） |
| 功能边界 | 仅设备业务告警；不处理 SQS/RDS/Lambda 等运维告警 |

## 2. 关键设计

**存储**（migration `20260830110000_business_notifications`）：
- `customer_notification_configs`：每 Customer 一行（customerId 唯一）：enabled、emailRecipients、webhookUrl；
- `notification_deliveries`：`idempotency_key`（`eventId:channel:target`）唯一索引 = 幂等键；status PENDING/SENT/FAILED + retryCount/lastError/sentAt 保存发送状态。

**派发**（`dispatchPendingNotifications`）：扫描 PENDING/PUBLISHED 领域事件（按 createdAt，批量上限）→ 防御性 severity 校验（非 CRITICAL 跳过，不产生投递）→ 按事件 customerId 查配置（无配置/停用/无目标 → 抑制）→ 白名单渲染 → 幂等创建投递记录（P2002 → 跳过不重发）→ 立即尝试发送（成功 SENT + sentAt；失败 FAILED + lastError + retryCount）。

**重试**（`retryFailedDeliveries`）：仅 FAILED 且 retryCount < maxAttempts（默认 5）；SENT 终态永不重发——重试不重复通知。

**内容安全**：通知内容白名单渲染（kind/code/category/message/eventType/状态迁移/deviceId/customerId/occurredAt），不透传原始报文全文；渲染结果再做敏感模式（password/secret/privateKey/token/verifier 等）fail-closed 检查（`NotificationError SENSITIVE_CONTENT`）。

**发送端口**：`EmailSender`/`WebhookSender` 注入接口，模块无 AWS 依赖（SES/HTTPS 实现由部署层接线）。"1 分钟内生成通知记录"由部署层定时调度（≤1min 触发 dispatch）保证；适配器本身随调随处理。

## 3. 验收基准与证据（vitest + PGlite，8 + 2 项）

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

- 调度与发送端口接线待部署层落地（Lambda 定时 ≤1min 触发 `dispatchPendingNotifications` + `retryFailedDeliveries`；EmailSender 接 SES、WebhookSender 接 HTTPS）；
- 通知配置暂无管理 API（测试直接落库）；如需后台维护 Customer 通知配置，需新任务定义 CRUD 与权限；
- FAILED 超过 maxAttempts 后无告警通道（死信观察依赖运维侧，属边界外）；
- Outbox 扫描不按事件去重游标推进，依赖投递幂等键兜底（事件量增长后可加 lastScannedAt 水位线优化）。
