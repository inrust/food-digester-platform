# DEC-020 冻结记录

## 变更元信息

| 字段                 | 值                                               |
| -------------------- | ------------------------------------------------ |
| 决策 ID              | DEC-020                                          |
| 变更类型             | register + freeze                                |
| 目标版本             | 1.0.0（frozen）                                  |
| 登记版本变更         | 1.28.0 → 1.29.0                                  |
| 批准人 / 时间（UTC） | 业务方（本次 P1 整改指令）/ 2026-09-08T12:45:00Z |

## 冻结值

- 算法：HMAC-SHA256；编码：`v1.<base64url(mac)>`，新签名不得输出无版本前缀格式。
- 规范载荷字段顺序：`licenseId`、`deviceId`、`customerId`、`validFrom`、`validTo`、`entitlements`；时间为 UTC ISO-8601，Entitlement 先映射为 wire code（`OTA`）再按字典序排序。
- 密钥按环境隔离，生产只从 KMS 加密的 Secrets Manager Secret 注入，不进入普通配置、响应、日志或审计。
- 轮换：签名端只使用 active key；设备验签端在迁移窗口同时保留 active/previous key。历史无 `v1.` 前缀签名只允许 previous key 验证，迁移窗口结束后失败关闭。

## 影响与验证

- 影响：BE-LIC-01、BE-SYNC-01、QA-02、Admin License/Device Sync 契约与设备验签实现。
- 固定测试向量锁定规范化与输出；`OTA_UPDATE` 只允许作为历史内部存储码，签名和 REST 均使用 `OTA`。
- Secrets Manager/KMS 与 API 最小读取权限由 CDK 模板测试锁定。
