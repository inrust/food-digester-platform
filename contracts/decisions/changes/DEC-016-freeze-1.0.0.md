# DEC-016 License/OTA 归档语义冻结记录

## 1. 变更元信息

| 字段     | 值                   |
| -------- | -------------------- |
| 决策 ID  | DEC-016              |
| 变更类型 | freeze               |
| 目标版本 | 1.0.0                |
| 批准人   | 业务方（用户确认）   |
| 批准时间 | 2026-09-04T10:58:43Z |

## 2. 方案 A 冻结内容

- 归档来源严格区分 `MQTT_RAW`、`DOMAIN_EVENT`、`OPERATION_RECORD`，统一使用 `archiveClass` 与 `envelopeVersion=1.0` 判别。
- 设备上行原文只进入 `raw/topic_type=...`；License 状态变化以 `LICENSE_STATUS_CHANGED` 领域事件进入 `domain/entity_type=license/...`。
- OTA 下发和结果分别以 `PUBLICATION`、`RESULT` 操作记录进入 `operations/operation_type=ota/record_type=...`。
- License/OTA 禁止使用 `topicType=license|ota` 伪装为设备上行 MQTT 原文。
- OTA `RESULT` 来源固定为 DEC-015 的 ACK `OTA_TARGET`；`PUBLICATION` 由 BE-OTA-03 的发布方在实际下发时写入。

## 3. 实施边界

- 本次实现 License 全状态变化领域归档、OTA ACK 结果归档、三类前缀分流与归档发布器事件过滤。
- 当前仓库尚无 BE-OTA-03 的 OTA 下发发布器；本次冻结其 `PUBLICATION` Envelope 和前缀并由 Worker 支持，待发布器任务实现时写入，不能伪造发布事实。
