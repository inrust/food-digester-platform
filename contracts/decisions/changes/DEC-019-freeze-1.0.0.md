# DEC-019 冻结记录

## 变更元信息

| 字段                 | 值                                                  |
| -------------------- | --------------------------------------------------- |
| 决策 ID              | DEC-019                                             |
| 变更类型             | register + freeze                                   |
| 目标版本             | 1.0.0（frozen）                                     |
| 登记版本变更         | 1.27.0 → 1.28.0                                     |
| 批准人 / 时间（UTC） | 业务方（本次 P0/P1 整改指令）/ 2026-09-08T08:30:00Z |

## 冻结值

- `null` 清除 alias；非空 alias 先去除首尾空白，再做 Unicode NFC 规范化。
- 规范化结果长度为 1～64 个 Unicode code point。
- 唯一性区分大小写，在同一 Customer 内强制；`customerId=null` 的未分配设备共同属于一个唯一性域。
- 数据库约束是最终并发裁决者；应用层预检仅用于友好错误，不作为唯一性证明。

## 影响与验证

- 影响：BE-DEV-06、FE-07、QA-06、Admin Device OpenAPI 和 `devices` 数据库约束。
- 统一策略源：`contracts/domain/device-alias-policy.json`；TS/OpenAPI/决策登记由 parity 测试锁定。
- 数据库使用部分表达式唯一索引覆盖已分配与未分配设备，并用 CHECK 约束长度、trim 和 NFC。
