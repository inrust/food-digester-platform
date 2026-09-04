# DEC-002 冻结记录

## 变更元信息

| 字段                 | 值                           |
| -------------------- | ---------------------------- |
| 决策 ID              | DEC-002                      |
| 变更类型             | freeze                       |
| 目标版本             | 1.0.0（frozen）              |
| 登记版本变更         | 1.22.0 → 1.23.0              |
| 批准人 / 时间（UTC） | Anray / 2026-09-04T08:33:33Z |

## 冻结值

- Telemetry、Report、Tamper 为 `AUDITED`，强制 `audit.hash`。
- Heartbeat、Alarm、Event、Ack、Media、Command、OTA、Notification 为 `STANDARD`。
- 未知 Topic 失败关闭；不得绕过 Topic Tier 策略添加或删除 audit。

## 影响与验证

- 影响 CT-03、BE-IOT-02、MQTT Catalog、11 个 Schema 与生成类型。
- Tier 变化属于线协议变更，必须提升 DEC-002 和受影响 Schema 版本。
