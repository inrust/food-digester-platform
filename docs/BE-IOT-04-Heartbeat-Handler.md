# BE-IOT-04 Heartbeat Handler

任务来源：`docs/管理后台开发任务清单.md` L471-479（BE-IOT-04，依赖 BE-IOT-03 / DOM-01）。

## 范围

校验后 Heartbeat 消息维护每设备唯一 latest state（在线、uptime、固件、运行模式、License、网络、资源、传感器、证书、Tamper）；RDS 只保留最新状态；不进入 Raw Archive；触发 Onboarding / 证书轮换确认扩展点。不实现离线定时判定与运维告警。

## 实现

模块：`apps/ingestion-worker/src/heartbeat/`

| 文件 | 职责 |
| --- | --- |
| [repository.ts](../apps/ingestion-worker/src/heartbeat/repository.ts) | `applyLatestState`：条件更新 `lastHeartbeatAt < occurredAt`（或为 NULL）才覆盖 → 乱序旧消息不倒退；无记录时 create，并发首创建败方（P2002）按 stale 处理。返回 `created / updated / stale` |
| [handler.ts](../apps/ingestion-worker/src/heartbeat/handler.ts) | `createHeartbeatHandler`：BE-IOT-03 receipt 幂等（键 `deviceId:heartbeat:seq`）→ 同事务业务写入（data → device_latest_state 全列映射）→ receipt 事务提交后触发扩展点 |
| [index.ts](../apps/ingestion-worker/src/heartbeat/index.ts) | 导出 |

字段映射（[handler.ts](../apps/ingestion-worker/src/heartbeat/handler.ts) `buildStateWrite`）：connectivity 固定 ONLINE（收到心跳即在线；离线判定属定时任务边界外）、operationalStatus、machineRunning、machineMode、firmwareVersion、licenseStatus、licenseExpiryDate（`YYYY-MM-DD` → UTC Date）、networkType/networkStatus/signalStrength、cpu/memory/storageUsagePct、sensorStatus JSON（overall/temperature/humidity/weight/gas）、certificateStatus、tamperStatus、uptimeSeconds、customerId（台账值）、lastHeartbeatAt = meta.ts。

## 扩展点接线（技术对接要求）

- 设备 `lifecycleStatus === 'OnboardingApproved'` → `completeOnboardingOnFirstHeartbeat`（BE-ONB-04：迁移 Onboarded + 证书 ACTIVE + 证书包销毁）；其他状态不触发（避免非目标状态审计噪音）。
- 每次 Heartbeat → `confirmCertificateRotationOnFirstHeartbeat`（BE-CERT-02/03：轮换新证书首心跳停用旧证 + 销毁新包 + PENDING 请求 COMPLETED；非轮换证书预检静默跳过）。
- 两扩展点各自幂等且管理自身事务，在 receipt 事务提交后调用；重复消息（DUPLICATE_SKIPPED）不触发。

## 验收证据

测试：[heartbeat-handler.test.ts](../apps/ingestion-worker/test/heartbeat-handler.test.ts)（PGlite 真实 PostgreSQL），5 项：

1. 首次 Heartbeat 全字段落库（含 sensorStatus JSON、licenseExpiryDate 转换、Decimal 资源列）；
2. 新消息覆盖旧状态；乱序旧 Heartbeat（seq 9 晚到）stateApplied=stale 不倒退；同 seq 同 Payload 重复 → DUPLICATE_SKIPPED；outbox 零事件（不进 Raw Archive，receipt 仅幂等台账）；
3. OnboardingApproved 设备首心跳完成 Onboarding（设备 Onboarded + 证书 ACTIVE + 包销毁），第二心跳静默幂等；
4. 轮换窗口新证书首心跳确认（旧证 REVOKED + 新包销毁 + 请求 COMPLETED），后续心跳不再确认；
5. 非 heartbeat 类型消息不处理（分发保护）。

命令与结果：

```text
pnpm vitest run apps/ingestion-worker   → Test Files 6 passed, Tests 26 passed
pnpm verify                              → EXIT=0（lint/format/typecheck/test 45 文件 356 项/build/boundaries/schemas/migrations/secrets）
```

## 未决风险

- `connectivity` 仅能在收到心跳时置 ONLINE；OFFLINE 依赖离线定时判定（任务边界外，需后续运维任务）。
- 乱序防护以 meta.ts（设备时钟，已经 BE-IOT-02 偏差校验）为比较基准；设备时钟回拨超容忍度的消息在 BE-IOT-02 已被 CLOCK_SKEW 隔离。
- operationalStatus 直接落设备自报值（ACTIVE/SUSPENDED/RETIRED），与设备台账 lifecycle 的权威关系待 DOM 系列明确（V1 按通信设计透传）。
