# 决策变更模板（DEC-xxx / PRI-xxx / ADP-xxx）

> 用途：对 `contracts/decisions/decision-register.json` 中任何条目的新增、冻结、修改或废止，必须复制本模板填写后随变更一并提交。禁止仅写在 README 或口头约定的非结构化备注。

## 1. 变更元信息

| 字段 | 值 |
|---|---|
| 决策 ID | DEC-xxx（新增时使用下一个未占用编号） |
| 变更类型 | register（新增登记）/ freeze（冻结）/ revise（修订）/ supersede（废止替代） |
| 目标版本 | x.y.z（frozen 必须 >= 1.0.0） |
| 登记版本变更 | registerVersion: a.b.c → x.y.z |
| 申请人 / 日期（UTC） |  |
| 批准人（freeze 必填） |  |

## 2. 决策内容

- **必须冻结的事项 / 冲突描述**：
- **当前暂定值（provisionalValue）**：
- **拟冻结值（freeze/revise 时填写）**：
- **依据来源（sourceRefs，须为 sourceDocuments 中的 id 或章节）**：

## 3. 影响分析

- **阻塞任务（blockingTasks）**：
- **影响模块（affectedModules）**：
- **受影响的契约文件（OpenAPI / JSON Schema / Topic Catalog）及其 `x-decision-versions` 更新**：
- **是否破坏既有契约兼容性**：是 / 否（是则需说明迁移策略）

## 4. 验证

- [ ] `node scripts/check-decisions.mjs` 通过
- [ ] `node --test scripts/` 通过
- [ ] 受影响契约文件的 `x-decision-versions` 已更新为 `决策ID@目标版本`
- [ ] `contracts/contract-version.json` 的 `decisionRegisterVersion` 与新 registerVersion 一致
- [ ] history 追加一条记录（version / at(UTC) / by / note）

## 5. 回滚

- **回滚方式**：（通常为 revert 本次提交并将 registerVersion 升级一个补丁版本，history 追加回滚记录）
