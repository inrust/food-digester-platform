# DEC-010 冻结记录

## 变更元信息

| 字段                 | 值                           |
| -------------------- | ---------------------------- |
| 决策 ID              | DEC-010                      |
| 变更类型             | freeze                       |
| 目标版本             | 1.0.0（frozen）              |
| 登记版本变更         | 1.22.0 → 1.23.0              |
| 批准人 / 时间（UTC） | Anray / 2026-09-04T08:33:33Z |

## 冻结值

- connectivity、lifecycle、operational、license 四轴独立建模。
- 启用仅在 lifecycle=`Active` 且 license 属于 `Active|ExpiringSoon|Renewed` 时派生为 true。
- connectivity 和 operational 不影响启用值；启用不独立落库。

## 影响与验证

- 影响 BE-DEV-01、BE-DEV-05、FE-03、FE-06。
- 状态轴或派生规则变化必须同步查询契约、展示和迁移评审。
