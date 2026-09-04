# DEC-001 Maintenance 行为矩阵

DEC-001 已由 Anray 于 2026-09-04T08:33:33Z 冻结为 `1.0.0`。正式记录见 [DEC-001-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-001-freeze-1.0.0.md)。

## 冻结值

- Maintenance 是独立 Operational 状态。
- 允许 Sync（900 秒）、遥测、告警、OTA、退役以及维护、诊断、安全停止命令。
- 禁止启动处理、加热、搅拌和排料等生产命令；未知行为失败关闭。

`pendingParameters=[]`，后续变更必须提升 DEC 与策略版本，不得静默修改消费者行为。

## 事实源与验证

- 策略：[contracts/lifecycle/maintenance-behavior-matrix.json](../../contracts/lifecycle/maintenance-behavior-matrix.json)
- 冻结记录：[contracts/decisions/changes/DEC-001-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-001-freeze-1.0.0.md)
- 专项测试：[contracts/lifecycle/maintenance-behavior.test.ts](../../contracts/lifecycle/maintenance-behavior.test.ts)
- 消费任务：DOM-01、BE-SYNC-01、BE-DEV-04、BE-CMD-01、BE-CMD-02

```bash
node --import tsx --test contracts/lifecycle/maintenance-behavior.test.ts
node scripts/check-decisions.mjs
node scripts/check-decisions.mjs trace contracts/lifecycle/maintenance-behavior-matrix.json
```
