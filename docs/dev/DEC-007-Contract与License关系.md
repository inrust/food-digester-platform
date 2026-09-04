# DEC-007 Contract 与 License 的关系

DEC-007 已由 Anray 于 2026-09-04T08:33:33Z 冻结为 `1.0.0`。正式记录见 [DEC-007-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-007-freeze-1.0.0.md)。

## 冻结值

- Contract 管商业租期和设备关联；License 管设备能力授权。
- 创建 Contract 不自动激活 License，解绑不自动撤销 License。
- 两者保持独立实体、状态机和页面展示。

`pendingParameters=[]`，后续变更必须提升 DEC 与策略版本，不得静默修改消费者行为。

## 事实源与验证

- 策略：[contracts/domain/contract-license-relation.json](../../contracts/domain/contract-license-relation.json)
- 冻结记录：[contracts/decisions/changes/DEC-007-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-007-freeze-1.0.0.md)
- 专项测试：[contracts/domain/contract-license-relation.test.ts](../../contracts/domain/contract-license-relation.test.ts)
- 消费任务：DB-01、BE-CON-01、BE-CON-02、BE-LIC-01、FE-17

```bash
node --import tsx --test contracts/domain/contract-license-relation.test.ts
node scripts/check-decisions.mjs
node scripts/check-decisions.mjs trace contracts/domain/contract-license-relation.json
```
