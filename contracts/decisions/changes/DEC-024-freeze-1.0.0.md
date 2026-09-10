# DEC-024 冻结记录

## 变更元信息

| 字段                 | 值                                               |
| -------------------- | ------------------------------------------------ |
| 决策 ID              | DEC-024                                          |
| 变更类型             | register + freeze                                |
| 目标版本             | 1.0.0（frozen）                                  |
| 登记版本变更         | 1.32.0 → 1.33.0                                  |
| 批准人 / 时间（UTC） | 业务方（本次 P2 整改指令）/ 2026-09-10T00:00:00Z |

## 冻结值

- Media：IMAGE 最大 10240KB，VIDEO 最大 204800KB。
- Media：每设备每个 UTC 自然日最多签发 100 个上传会话；ISSUED 会话计入配额。
- Media：上传和下载预签名 URL TTL 均为 900 秒。
- Connectivity：`lastHeartbeatAt` 非空且 `now - lastHeartbeatAt <= 600 秒` 时为 `ONLINE`，否则为 `OFFLINE`；600 秒边界包含，不写回生命周期状态。
- 上游时间戳可信度和未来时钟偏差继续由既有 Ingestion 校验负责，本决策不放宽消息时间验证。

## 影响与验证

- 影响 BE-MED-01、BE-DASH-01、BE-DEV-01/05、FE-03/06 和 QA-06。
- Media 策略版本提升到 1.0.0/frozen，清空 pendingParameters；策略 JSON、TypeScript 门面、OpenAPI 与测试保持一致。
- Connectivity 的边界测试覆盖 600 秒为 ONLINE、超过 1ms 为 OFFLINE；Dashboard、Device、Console、Sync 与 Consumable 复用同一常量。
