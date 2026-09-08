# DEC-021 freeze 1.0.0

- 状态：`frozen`
- 批准时间：2026-09-08T14:15:00Z
- 批准依据：业务方本次 P2 整改指令

Contract 的 `EXPIRING_SOON` 窗口冻结为 30 个自然日，精确按 `30 × 86400` 秒计算。`at >= endAt` 为 `EXPIRED`；否则 `at >= endAt - 30 days` 为 `EXPIRING_SOON`，窗口起点包含边界。所有输入均按 UTC instant 比较，状态派生、列表筛选、evaluate 与 renew 必须使用同一规则。
