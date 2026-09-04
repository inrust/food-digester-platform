# DEC-002 Topic Tier 标记

DEC-002 已由 Anray 于 2026-09-04T08:33:33Z 冻结为 `1.0.0`。正式记录见 [DEC-002-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-002-freeze-1.0.0.md)。

## 冻结值

- Telemetry、Report、Tamper 为 `AUDITED`，强制 `audit.hash`。
- Heartbeat、Alarm、Event、Ack、Media、Command、OTA、Notification 为 `STANDARD`。
- 未知 Topic 失败关闭；Tier 变化属于线协议变更。

`pendingParameters=[]`，后续变更必须提升 DEC 与策略版本，不得静默修改消费者行为。

## 事实源与验证

- 策略：[contracts/mqtt/topic-tier.json](../../contracts/mqtt/topic-tier.json)
- 冻结记录：[contracts/decisions/changes/DEC-002-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-002-freeze-1.0.0.md)
- 专项测试：[contracts/mqtt/topic-tier.test.ts](../../contracts/mqtt/topic-tier.test.ts)
- 消费任务：CT-03、BE-IOT-02

```bash
node --import tsx --test contracts/mqtt/topic-tier.test.ts
node scripts/check-decisions.mjs
node scripts/check-decisions.mjs trace contracts/mqtt/topic-tier.json
```
