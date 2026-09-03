# DEC-007 Contract 与 License 的关系

DEC-007 是协议冻结门禁决策（当前 `pending`，登记版本 `0.2.0`）。按《管理后台开发任务清单》§4 末段，本任务把暂定值落地为数据驱动、可整体替换的策略扩展点。**决策本身未冻结，冻结必须经业务方批准人按 [decision-change-template.md](../contracts/decisions/decision-change-template.md) 执行。**

## 暂定值（provisional）

> Contract 管商业租期和设备关联；License 管设备能力授权；创建 Contract 不自动激活 License。

全部为定性规则，已可直接执行：

| 策略面 | 暂定结论 | 消费任务 |
|---|---|---|
| 职责划分 | Contract=`commercial-lease-term`+`device-association`；License=`device-capability-authorization`；独立实体、独立状态机（DOM-03） | DB-01、BE-CON-01、BE-CON-02、BE-LIC-01、DOM-03 |
| 联动 | 创建 Contract **不**自动激活 License；解绑 **不**自动撤销 License；续约走 `renewContract` | BE-CON-01、BE-CON-02、BE-LIC-01 |
| 展示 | Contract 状态与 License 状态独立展示，禁止混同 | FE-17、BE-CON-02 |

`pendingParameters` 为空：本决策无待定参数，冻结时若暂定值不变仅需改状态。

## 文件

| 文件 | 说明 |
|---|---|
| [contracts/domain/contract-license-relation.json](../contracts/domain/contract-license-relation.json) | 策略数据事实源 |
| [contracts/domain/contract-license-relation.schema.json](../contracts/domain/contract-license-relation.schema.json) | 策略结构契约（联动与展示规则布尔锁定） |
| [contracts/domain/contract-license-relation.ts](../contracts/domain/contract-license-relation.ts) | 查询函数（`getScopeOwner`、`doesContractCreateActivateLicense` 等） |
| [contracts/domain/contract-license-relation.test.ts](../contracts/domain/contract-license-relation.test.ts) | 结构、负向与一致性测试（含 prototype-traceability.yaml 版本同步断言） |

## 使用约束

1. DB-01 的 Contract 与 License 表结构必须独立，任何一方不得并入对方字段；
2. BE-CON-01 `createContract` 返回成功即结束，不得触发 License 激活副作用；
3. BE-CON-02 `unbindContractDevice` 不得联动撤销 License；
4. FE-17 合约列表"状态"列只显示 Contract 状态；License 摘要经 `getDeviceLicense.summary` 独立展示。

## 冻结升级路径

1. 业务方批准 DEC-007（登记升至 `>= 1.0.0`、`frozen`）；
2. 暂定值未变化：`status` 改 `frozen`，提升 `policyVersion` 即可；
3. 若变化：重新评审 linkage/presentation，并同步 [prototype-traceability.yaml](../contracts/prototype-traceability.yaml) 相关 basis。

## 验证命令

```bash
node --test "contracts/domain/contract-license-relation.test.ts"
node scripts/check-decisions.mjs
node scripts/check-decisions.mjs trace contracts/domain/contract-license-relation.json contracts/prototype-traceability.yaml
```
