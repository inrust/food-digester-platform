# DEC-015 新增登记记录

## 1. 变更元信息

| 字段 | 值 |
|---|---|
| 决策 ID | DEC-015 |
| 变更类型 | register（新增登记） |
| 目标版本 | 0.1.0（pending） |
| 登记版本变更 | registerVersion: 1.12.0 → 1.18.0 |
| 申请人 / 日期（UTC） | CT-01 / 2026-09-04T01:44:04Z |
| 批准人 | 不适用；本次未冻结 |

## 2. 决策内容

- **必须冻结的事项 / 冲突描述**：源稿未定义多阶段 OTA 状态的设备上行 Topic 与 Payload。
- **当前暂定值**：在 ACK 扩展、新 `ota/status` Topic 或 AWS IoT Jobs 状态事件中选择唯一通道。
- **拟冻结值**：不适用；状态保持 pending。
- **依据来源**：`device-cloud-communication-design`、`aws-implementation-plan`。

## 3. 影响分析

- **阻塞任务**：CT-02、CT-03、AUTH-04、BE-OTA-03、QA-01、QA-02、QA-03。
- **影响模块**：CT、AUTH、BE-OTA、QA。
- **受影响契约**：Topic Catalog、ACK/OTA Schema、IoT Policy、模拟器；冻结前不修改其 `x-decision-versions`。
- **兼容性**：本次仅登记，无既有契约变更。

## 4. 验证与回滚

- `node scripts/check-decisions.mjs` 和决策脚本测试必须通过。
- 回滚方式：revert 本次登记提交；后续如需回滚已发布登记，按模板提升 registerVersion 并追加 history。
