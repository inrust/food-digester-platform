# DOM-02 License 状态机与商业规则

实现：[packages/domain/src/license.ts](../packages/domain/src/license.ts)；测试：[license.test.ts](../packages/domain/test/license.test.ts)（16 项，含 40 组非法迁移穷举）。

## 1. 状态机（实施方案 11.3）

```text
NoLicense(虚拟，不落库) → Draft → Issued → Active → ExpiringSoon → Renewed → Active
                                  │   └──────────→ Expired
                                  └→ Revoked（Active/Expired，必填原因）
```

- `Draft → Issued`：平台管理员/操作员；`Issued → Active`：SYSTEM/DEVICE（同步确认）；
- `Active/ExpiringSoon → Expired`、`Active → ExpiringSoon`：仅 SYSTEM，经 `evaluateLicenseAt(now)` 时间派生（可注入时间，不做定时扫描）；
- `Renewed → Active`：SYSTEM；
- Entitlement 封闭集合：`REMOTE_CONTROL / OTA_UPDATE / ESG_REPORTING`，创建时非空校验。

## 2. 商业规则

- `createLicenseDraft`：`ctx.noOtherValidLicense` 强制（一个设备仅一个有效 License；DB 层另有部分唯一索引兜底）；`validFrom < validTo`。
- `assertDeviceRunnable(facts, now)`：无 Assignment 或无有效 License 时抛 `DEVICE_STATE_NOT_ALLOWED`，供 DOM-01 `Licensed → Active` 与 BE-DEV 激活路径复用。
- `isLicenseEffective`：`Issued/Active/ExpiringSoon/Renewed` 且在 `[validFrom, validTo)` 内。
- 每次创建/迁移产出：license_history 条目 + 审计事件 + `LICENSE_CHANGED` 通知描述符（投递由 BE-LIC-01 负责）。

## 3. 重复请求的确定结果

- 续期：已 `Renewed` 且 `validTo` 相同 → 幂等回放（`idempotentReplay: true`，状态不变）；不同 → `CONFLICT`；
- 撤销：已 `Revoked` 再撤销 → 非法迁移错误（终态）；
- 到期派生：`evaluateLicenseAt` 纯函数，同输入同结果。

## 4. 验收基准与证据

| 验收基准 | 证据 |
|---|---|
| 无 Assignment 激活失败 | `assertDeviceRunnable({hasActiveAssignment:false})` 抛错 ✅ |
| 无有效 License 激活失败 | null / Expired / Revoked / 已过有效期均抛错 ✅ |
| 续期确定结果 | 正常续期、幂等回放、CONFLICT、validTo 倒退拒绝 ✅ |
| 到期确定结果 | 窗口内 ExpiringSoon、超过 validTo Expired、窗口外不变、幂等 ✅ |
| 撤销确定结果 | Active/Expired → Revoked 成功；重复撤销拒绝 ✅ |
| 非法迁移 | 7×7 穷举 40 组未列出迁移全部拒绝 ✅ |

全仓 `pnpm verify` 通过。

## 5. 未决风险

- ExpiringSoon 窗口默认 30 天（`DEFAULT_EXPIRING_SOON_WINDOW_MS`），文档未规定具体值；可注入参数，冻结后可调整默认值；
- `ExpiringSoon → Revoked` 未开放（严格按 11.3 仅 Active/Expired）；若业务需要，先更新文档再扩展迁移表。
