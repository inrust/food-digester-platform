# DEC-013 冻结记录

## 1. 变更元信息

| 字段            | 值                   |
| --------------- | -------------------- |
| 决策 ID         | DEC-013              |
| 变更类型        | freeze               |
| 目标版本        | 1.0.0                |
| 登记版本        | 1.24.0               |
| 契约版本        | 0.4.0                |
| 批准人          | Anray                |
| 批准时间（UTC） | 2026-09-04T09:46:26Z |

## 2. 冻结内容

- Heartbeat 正式结构为扁平字段；嵌套旧结构自生效时间起兼容 90 天。
- `storageUsagePct` 为可选 `number`，范围 0～100，禁止 `null`。
- Telemetry 正式字段为 `currentAmp`，兼容旧字段 `motorCurrentAmp` 90 天。
- Machine Mode 正式枚举为 `DISCHARGING`，兼容旧拼写 `DISCHARING` 90 天。
- 非 Heartbeat Topic 中源稿未明确必填的字段保持可选；字段存在时严格校验类型、单位和范围，禁止 `null`、未知字段及设备声明身份字段。
- `audit.hash` 覆盖剔除 `audit` 后的 `{meta,data}`，按 RFC 8785 JSON Canonicalization Scheme 规范化后计算 SHA-256，输出 64 位小写十六进制。
- `audit.hash` 只提供内容完整性核对，不作为设备签名；防重放由 mTLS 身份、`meta.seq` 与收据幂等共同承担。

## 3. 兼容窗口

- 生效时间：`2026-09-04T09:46:26Z`。
- 兼容截止时间：`2026-12-03T09:46:26Z`（90 天）。
- 窗口内旧结构在入口转换为正式结构；正式结构与旧字段同时出现且值冲突时失败关闭。
- 截止时间后，嵌套 Heartbeat、`motorCurrentAmp` 与 `DISCHARING` 均按协议违规拒绝。

## 4. 验证要求

- MQTT Schema、生成类型与 Fixture 必须引用 `DEC-013@1.0.0`。
- 固定测试向量必须覆盖 RFC 8785 规范化文本及 SHA-256 结果。
- 兼容测试必须覆盖旧结构转换、别名转换、冲突拒绝及截止边界。
- Ingestion 必须在业务处理前验证 `audit.hash`，不匹配消息进入 Quarantine。
