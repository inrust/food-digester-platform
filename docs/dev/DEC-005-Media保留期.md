# DEC-005 Media 文件与元数据保留期

DEC-005 已由 Anray 于 2026-09-04T08:33:33Z 冻结为 `1.0.0`。正式记录见 [DEC-005-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-005-freeze-1.0.0.md)。

## 冻结值

- RDS 元数据保留 365 天；S3 文件保留 90 天。
- 文件到期删除，但元数据和完整性 Hash 继续保留至 365 天到期。
- 到期动作固定为 `delete-file-keep-metadata`。

`pendingParameters=[]`，后续变更必须提升 DEC 与策略版本，不得静默修改消费者行为。

## 事实源与验证

- 策略：[contracts/media/media-retention-policy.json](../../contracts/media/media-retention-policy.json)
- 冻结记录：[contracts/decisions/changes/DEC-005-freeze-1.0.0.md](../../contracts/decisions/changes/DEC-005-freeze-1.0.0.md)
- 专项测试：[contracts/media/media-retention-policy.test.ts](../../contracts/media/media-retention-policy.test.ts)
- 消费任务：BE-MED-01、FE-14、BE-ARC-02

```bash
node --import tsx --test contracts/media/media-retention-policy.test.ts
node scripts/check-decisions.mjs
node scripts/check-decisions.mjs trace contracts/media/media-retention-policy.json
```
