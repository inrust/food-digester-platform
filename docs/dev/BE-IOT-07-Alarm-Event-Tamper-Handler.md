# BE-IOT-07 Alarm/Event/Tamper Handler

任务来源：`docs/管理后台开发任务清单.md` L501-509（BE-IOT-07，依赖 BE-IOT-03 / DB-02 / DOM-01）。

## 范围

分别处理 Alarm ACTIVE/CLEARED、操作 Event、Tamper 三类上行信号；保存历史、生成归档事件；按策略触发设备挂起领域动作。不发送基础设施运维告警。

## 实现

模块：`apps/ingestion-worker/src/signals/`

| 文件 | 职责 |
| --- | --- |
| [archive.ts](../../apps/ingestion-worker/src/signals/archive.ts) | 共享归档 outbox 写入（原始 Payload + payloadHash + audit.hash + 映射列）；`requireCustomerId`（三表 customerId 非空，未分配隔离待 Replay） |
| [alarm.ts](../../apps/ingestion-worker/src/signals/alarm.ts) | ACTIVE：插入新 Alarm 行（每次激活独立记录）；CLEARED：条件关闭同设备同 code 全部 ACTIVE 行（status→CLEARED + clearedAt=清除消息 detectedTime）；重复 CLEAR/无 ACTIVE → `clear-noop` 幂等；两类信号各生成一个归档事件 |
| [event.ts](../../apps/ingestion-worker/src/signals/event.ts) | 仅写 device_events（occurredAt=meta.ts）+ 归档；不创建 Alarm（信号通道分离） |
| [tamper.ts](../../apps/ingestion-worker/src/signals/tamper.ts) | tamper_events 历史 + 归档（audit.hash 保留，DEC-002）；策略 `TAMPER_SUSPEND_SEVERITIES=['CRITICAL']` → DOM-01 Active→Suspended 自动挂起 |

## 策略挂起（技术对接要求）

- **DOM-01 扩展**：`Active → Suspended` 新增 SYSTEM actor 规则（requiresReason；[device-lifecycle.ts](../../packages/domain/src/device-lifecycle.ts)），并将规则匹配从"首条 to 匹配"修正为"actorType 优先匹配"（同 from→to 多规则并存：ADMIN 管理挂起 / SYSTEM 策略挂起）；既有"DEVICE/SYSTEM 不能执行管理迁移"锁定测试更新为"SYSTEM 仅允许策略挂起且必须填原因，其他管理迁移仍禁止"，并新增 LEGAL 锁定用例。
- **只挂起一次**：预检 `lifecycleStatus='Active'` + 条件更新 `(id, lifecycleStatus='Active')` 并发兜底；已 Suspended/其他生命周期/第二个 Tamper → 不再迁移（事件仍保存）。
- **策略原因与审计**：reason=`TAMPER_AUTO_SUSPEND: severity=CRITICAL, eventType=...`；stateHistory（lifecycle + operational 镜像两轴）+ `recordAudit(SUCCESS)` 与 tamper 事件、归档在同一 receipt 事务原子提交。

## 验收证据

测试：[signals-handlers.test.ts](../../apps/ingestion-worker/test/signals-handlers.test.ts)（PGlite 真实 PostgreSQL）及 DOM-01 领域测试：

1. Alarm ACTIVE 建行（数值落 String 列、detectedTime 映射）→ CLEARED 正确闭合（status + clearedAt）；重复 CLEAR `clear-noop` 幂等；每次合法信号一个归档；同 seq 重放 receipt 跳过；
2. Event 仅写 device_events + 归档，**不误创建 Alarm**（alarms 零行）；
3. CRITICAL Tamper：事件保存 + 归档含 audit.hash + 挂起一次（设备 Suspended、两轴状态史、恰好一条含策略原因的 SUCCESS 审计）；第二个 CRITICAL Tamper 事件照存但不再挂起、审计仍一条；
4. WARNING Tamper 不挂起（非策略严重度）；
5. 非 Active 生命周期设备 CRITICAL Tamper 不挂起；
6. 三个 Handler 分发保护（非本类型不处理）。

当前证据命令：`pnpm vitest run apps/ingestion-worker/test/signals-handlers.test.ts packages/domain/test` 与 `pnpm verify`。精确结果见 [BE-IOT-01 至 BE-IOT-09 全面复盘检查报告](../audit/BE-IOT-01至BE-IOT-09全面复盘检查报告-2026-09-07.md)。

## 未决风险

- 挂起策略集合（CRITICAL）为 V1 暂定封闭值，协议冻结后可能扩展为多级策略（集合已常量化，便于调整）。
- ACTIVE Alarm 每次激活独立建行（保存历史）；同 code 未闭合重复激活不去重（去重口径待运维需求明确）。
- CLEAR 关闭同 code 全部 ACTIVE 行（通信设计未给出 alarm 实例 ID，按 code 聚合闭合）。
