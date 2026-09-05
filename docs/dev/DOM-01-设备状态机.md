# DOM-01 Device 与 Operational 状态机

实现：[packages/domain/src/device-lifecycle.ts](../../packages/domain/src/device-lifecycle.ts)；测试：[device-lifecycle.test.ts](../../packages/domain/test/device-lifecycle.test.ts)。

## 1. 模型决策（DEC-010 四轴分离）

任务清单列举的 10 个状态按 DEC-010/DEC-001 拆分为两轴，不共用一个字段：

- **Lifecycle 轴（9 态）**：`PendingOnboarding | Rejected | OnboardingApproved | Onboarded | Assigned | Licensed | Active | Suspended | Retired`
- **Operational 轴（4 态）**：`Active | Maintenance | Suspended | Retired`；Maintenance 是独立状态（DEC-001），仅允许 `Active ↔ Maintenance`（管理员、必填原因）；`Suspended/Retired` 由生命周期迁移镜像派生，无主动迁移。

## 2. 迁移表（实施方案 8.1 唯一事实源）

| From | To | 执行者 | 前置条件 |
|---|---|---|---|
| PendingOnboarding | OnboardingApproved | PlatformSuperAdmin | deviceValidated |
| PendingOnboarding | Rejected | PlatformSuperAdmin | 必填原因 |
| OnboardingApproved | Onboarded | SYSTEM/DEVICE | certificateInstalled + firstHeartbeatReceived（内部 PROVISIONING 步骤） |
| Onboarded | Assigned | PlatformSuperAdmin | assignment（已存在 Customer+Site） |
| Assigned | Licensed | SYSTEM | licenseIssuedAndSynced |
| Licensed | Active | DEVICE | licenseVerifiedByDevice（派生 operational=Active） |
| Active | Suspended | SuperAdmin/Operator | 必填原因（镜像 operational=Suspended） |
| Suspended | Active | SuperAdmin/Operator | issueResolvedApproved + 原因 |
| Active/Suspended | Retired | PlatformSuperAdmin | 必填原因（镜像 operational=Retired） |

约束：Provisioning 无外部状态（无 `Provisioned`）；`Retired`、`Rejected` 为终态。

## 3. 效果与失败语义

- 成功迁移返回 `TransitionEffects`：state_history 条目（lifecycle 变更 + operational 镜像各一条）与审计事件描述符；持久化由调用方在 DB-02 事务内完成。
- 失败抛 `DeviceStateError`（code ∈ `DEVICE_STATE_NOT_ALLOWED` / `FORBIDDEN` / `VALIDATION_FAILED`），不返回 effects、不修改入参（测试用 `Object.freeze` 证明纯度）。

## 4. 验收基准与证据

| 验收基准 | 证据 |
|---|---|
| 文档允许转换全部成功 | 10 条生命周期迁移 + Active↔Maintenance 逐条测试通过 |
| 任意非法跳转失败 | 生命周期 9×9 穷举：81 个未列出迁移全部抛错 |
| 失败时状态和历史均不变化 | 纯函数：抛错无 effects 返回，冻结入参未被修改 |
| 执行者/前提/原因 | 角色不足（Operator 审批/分配/退役）、缺前提（6 类）、缺原因（4 类）分别拒绝 |

使用 `pnpm verify` 复验；数据库测试同时锁定 `axis` 非空封闭枚举和 lifecycle/operational 同名状态可区分。精确快照见[2026-09-05 P2 整改证据报告](../audit/ENG-DB-DOM-P2证据与文档维护报告-2026-09-05.md)。

## 5. 未决风险

- DEC-001@1.0.0 已冻结：Maintenance 行为限制由矩阵统一约束；后续变更仅经新决策版本调整消费方（BE-CMD/BE-SYNC），状态机迁移表不受影响；
- 已接入的 Cloud API 与 ingestion-worker 消费者均把 `stateHistory[].axis` 写入数据库；新增消费者仍必须通过 DB-01 的非空枚举约束和回归测试。
