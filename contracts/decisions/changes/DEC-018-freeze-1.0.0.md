# DEC-018 冻结记录

## 变更元信息

| 字段                 | 值                                       |
| -------------------- | ---------------------------------------- |
| 决策 ID              | DEC-018                                  |
| 变更类型             | freeze                                   |
| 目标版本             | 1.0.0（frozen）                          |
| 登记版本变更         | 1.18.0 → 1.22.0                          |
| 批准人 / 时间（UTC） | 业务方（用户确认）/ 2026-09-04T04:40:30Z |

## 冻结值

| 字段                    | 单位 |    范围 | 默认值 |
| ----------------------- | ---: | ------: | -----: |
| `heartbeatInterval`     |   秒 | 10～900 |     60 |
| `telemetryInterval`     |   秒 | 5～3600 |     30 |
| `cameraRefreshInterval` | 分钟 | 1～1440 |      1 |
| `temperatureThreshold`  |   °C |  0～120 |     80 |

V1 只允许以上四字段。图像、旋转、电机阈值、温度上下限、语言和网络字段均不属于 V1。

## 影响与验证

- 影响：CT-03、BE-CFG-01、BE-SYNC-01、FE-09、QA-02、Admin Configuration/Device Sync OpenAPI 和领域校验。
- 统一策略源：`contracts/configuration/configuration-v1-policy.json`，由 JSON Schema 与跨层一致性测试锁定。
- 对未知字段和越界值返回 400，不做静默裁剪或单位换算。
- 回滚：新增字段只能通过版本化扩展与设备能力协商进入后续协议，不得直接放宽 V1。
