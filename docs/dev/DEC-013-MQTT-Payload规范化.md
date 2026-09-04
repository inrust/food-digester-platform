# DEC-013 MQTT Payload 规范化

## 冻结状态

- 版本：`DEC-013@1.0.0`
- 状态：`frozen`
- 批准人：Anray
- 批准时间：`2026-09-04T09:46:26Z`
- 策略事实源：[payload-normalization-policy.json](../../contracts/mqtt/payload-normalization-policy.json)
- 冻结记录：[DEC-013-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-013-freeze-1.0.0.md)

## 正式协议

1. Heartbeat `data` 使用扁平字段；`storageUsagePct` 可选，类型为 `number`，范围 0～100，禁止 `null`。
2. Telemetry 电机电流正式字段为 `currentAmp`。
3. Machine Mode 正式枚举为 `DISCHARGING`。
4. 非 Heartbeat 源稿未明确必填的字段保持可选；存在时严格校验类型、单位和范围。所有 Schema 均失败关闭：禁止 `null`、未知字段以及 `customerId`、`tenantId`、`deviceId` 等设备声明身份字段。
5. Telemetry、Report、Tamper 的 `audit.hash` 为 `SHA-256(RFC8785({meta,data}))`，输入编码 UTF-8，结果为 64 位小写十六进制。
6. Hash 只用于内容完整性核对，不代替签名；防重放由 mTLS 设备身份、`meta.seq` 和 Ingestion Receipt 幂等共同完成。

## 兼容期

兼容窗口为 `2026-09-04T09:46:26Z` 至 `2026-12-03T09:46:26Z`，截止时刻为排他边界。窗口内 Ingestion 入口支持：

- Heartbeat `network/system/machine/sensorStatus` 旧嵌套结构；
- Telemetry `motorCurrentAmp`；
- Machine Mode `DISCHARING`。

入口先按消息原文复算 Audited Topic 的 `audit.hash`，再把旧结构转换为正式结构。新旧字段并存且值冲突、未知旧字段、或兼容期结束后仍使用旧格式，均进入 Quarantine，不进入业务处理。

## 验收收据

- 固定 RFC 8785 规范化文本及 SHA-256 测试向量；
- 正式 Schema、类型生成器和 11 类 Fixture 追溯 `DEC-013@1.0.0`；
- 嵌套 Heartbeat、`motorCurrentAmp`、`DISCHARING` 的兼容转换测试；
- 同值并存、冲突、截止边界和 Hash 不匹配的失败关闭测试；
- Ingestion 使用 `AUDIT_HASH_MISMATCH` / `SCHEMA_VIOLATION` 稳定隔离原因与路径。
