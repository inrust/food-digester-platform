# DEC-023 冻结记录

## 变更元信息

| 字段                 | 值                                               |
| -------------------- | ------------------------------------------------ |
| 决策 ID              | DEC-023                                          |
| 变更类型             | register + freeze                                |
| 目标版本             | 1.0.0（frozen）                                  |
| 登记版本变更         | 1.31.0 → 1.32.0                                  |
| 批准人 / 时间（UTC） | 业务方（本次 P2 整改指令）/ 2026-09-09T03:45:09Z |

## 冻结值

- V1 高风险 Command 采用“近期重新认证 + 显式命令名确认”。
- 请求只允许 `confirmation.confirmText`，并须精确等于 Command code；客户端不得提交确认时间。
- 重新认证时间只取服务端验签 Cognito JWT 的 `auth_time`，由 `command.confirmation.ttlSec/maxFutureSec` 控制有效窗口；缺少、过期或未来值均失败关闭为 `FORBIDDEN`。
- `command.authorize` 审计记录 `DEC-023@1.0.0`、确认方式、actor 与可信 `authenticatedAt`。
- 本机制不证明 MFA 或双人审批；若后续要求 MFA 或独立审批，必须提升 DEC 版本并引入可验证的新凭证。

## 影响与验证

- 影响 AUTH-01、BE-CMD-01、BE-SET-01、FE-12 和 QA-06。
- 负向验证覆盖客户端伪造时间字段、缺失/过期/未来 `auth_time`；正向验证覆盖近期认证和审计投影。
