# DEC-017 新增登记记录

## 1. 变更元信息

| 字段                 | 值                               |
| -------------------- | -------------------------------- |
| 决策 ID              | DEC-017                          |
| 变更类型             | register（新增登记）             |
| 目标版本             | 0.1.0（pending）                 |
| 登记版本变更         | registerVersion: 1.12.0 → 1.18.0 |
| 申请人 / 日期（UTC） | CT-01 / 2026-09-04T01:44:04Z     |
| 批准人               | 不适用；本次未冻结               |

## 2. 决策内容

- **必须冻结的事项 / 冲突描述**：首次合法 Heartbeat 长期未到达时的截止时间、外部状态与证书处置未定义。
- **当前暂定值**：使用可重复执行的超时评估器；期限、响应、撤证、重签和重新申请规则待双方确认。
- **拟冻结值**：不适用；状态保持 pending。
- **依据来源**：`device-cloud-communication-design`、`aws-implementation-plan`。

## 3. 影响分析

- **阻塞任务**：BE-ONB-03、BE-ONB-04、QA-02、QA-04。
- **影响模块**：BE-ONB、QA。
- **受影响契约**：Device Onboarding OpenAPI、证书包策略；冻结前不修改其 `x-decision-versions`。
- **兼容性**：本次仅登记，无既有契约变更。

## 4. 验证与回滚

- `node scripts/check-decisions.mjs` 和决策脚本测试必须通过。
- 回滚方式：revert 本次登记提交；后续如需回滚已发布登记，按模板提升 registerVersion 并追加 history。
