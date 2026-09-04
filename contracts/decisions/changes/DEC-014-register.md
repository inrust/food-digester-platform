# DEC-014 新增登记记录

## 1. 变更元信息

| 字段                 | 值                               |
| -------------------- | -------------------------------- |
| 决策 ID              | DEC-014                          |
| 变更类型             | register（新增登记）             |
| 目标版本             | 0.1.0（pending）                 |
| 登记版本变更         | registerVersion: 1.12.0 → 1.18.0 |
| 申请人 / 日期（UTC） | CT-01 / 2026-09-04T01:44:04Z     |
| 批准人               | 不适用；本次未冻结               |

## 2. 决策内容

- **必须冻结的事项 / 冲突描述**：Retired 后立即拒绝证书会阻断 Sync 与 Deactivate，形成退役认证死锁。
- **当前暂定值**：确认待处理期间证书保持 Active，仅允许 Sync/Deactivate；确认或强制完成后撤证。
- **拟冻结值**：不适用；状态保持 pending。
- **依据来源**：`device-cloud-communication-design`、`aws-implementation-plan`。

## 3. 影响分析

- **阻塞任务**：AUTH-03、DOM-01、BE-SYNC-01、BE-SYNC-02、BE-DEV-04、QA-06。
- **影响模块**：AUTH、DOM、BE-SYNC、BE-DEV、QA。
- **受影响契约**：Device Sync/Deactivate OpenAPI、设备授权矩阵；冻结前不修改其 `x-decision-versions`。
- **兼容性**：本次仅登记，无既有契约变更。

## 4. 验证与回滚

- `node scripts/check-decisions.mjs` 和决策脚本测试必须通过。
- 回滚方式：revert 本次登记提交；后续如需回滚已发布登记，按模板提升 registerVersion 并追加 history。
