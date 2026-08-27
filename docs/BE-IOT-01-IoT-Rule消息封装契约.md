# BE-IOT-01 IoT Rule 消息封装契约

契约：[contracts/iot/ingress-envelope.schema.json](../contracts/iot/ingress-envelope.schema.json) + [ingress-envelope.fixtures.json](../contracts/iot/ingress-envelope.fixtures.json)；Rule SQL/Action：[app-dependencies-stack.ts](../infra/src/stacks/app-dependencies-stack.ts)（`createIotIngestionRules`）；测试：[ingress-envelope.test.mjs](../contracts/iot/ingress-envelope.test.mjs)、[iot-rule-envelope.test.ts](../infra/test/iot-rule-envelope.test.ts)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-IOT-01（P1 / IoT 后端），依赖 CT-02、CT-03、IAC-01（均已交付） |
| Envelope | 设备原始 Payload 全字段平铺（`SELECT *`，useBase64=false 保留 JSON 原文）+ 五个 `iot*` 保留上下文字段 |
| 上下文字段 | `iotTopic`（topic()）、`iotDeviceId`（topic(3)）、`iotType`（topic(4)）、`iotReceivedAt`（timestamp()，epoch 毫秒）、`iotPrincipal`（principal()，证书 ARN） |
| 路由 | 8 个上行 Topic 各自一条 Rule → 同一 Ingress SQS；Error Action → 独立 `iot-rule-error` 队列 |
| 功能边界 | 不做业务入库（Schema 校验/入库归 BE-IOT-02） |

## 2. 信任边界（技术对接要求）

- Payload 内设备自报的任何身份字段（customerId、meta.deviceId 等）**不可信**，仅作业务数据透传；
- 消费端身份只能由 `iotDeviceId`（Topic 第三段；发布权限由 AUTH-04 单设备 Policy 按 Thing 收敛）与 `iotPrincipal`（证书 ARN，对照 `device_certificates` 台账）解析；
- `iot*` 为保留前缀，由 IoT Rule 注入，设备侧无法伪造（ uplink Payload Schema 的 meta/data 均为 additionalProperties:false 封闭结构）。

## 3. 验收基准与证据

| 验收基准 | 证据 | 结果 |
|---|---|---|
| 8 类消息进入同一队列并保留原文 | CDK 断言：8 条 Rule 的 Action 指向同一 Ingress 队列、SELECT * + useBase64=false | ✅ |
| 未知 Topic 不进入业务链路 | 断言仅 8 个精确过滤器（`bnx/device/+/{type}`），无 `#` 通配订阅 | ✅ |
| Error Action 写独立错误队列 | 8 条 Rule 的 ErrorAction 均指向 iot-rule-error 队列，且 ≠ Ingress | ✅ |
| 契约与实现奇偶 | Schema required/enum ↔ SQL 注入字段 ↔ UPLINK_TOPIC_TYPES 三方一致断言 | ✅ |
| 非法 Envelope 稳定拒绝 | 5 类非法 Fixture（缺字段/未知类型/空 deviceId/负时间戳）路径正确 | ✅ |

`pnpm --filter @fdp/contracts test` 149/149 通过；`pnpm vitest run infra/test` 30/30 通过；全仓 `pnpm verify` 退出 0（2026-08-27）。

## 4. 对接说明

- **BE-IOT-02**（ingestion-worker）：按 Envelope 解析 `iotDeviceId`/`iotType`/`iotPrincipal` 做台账解析与 Schema 校验；Payload 原文在顶层平铺字段中；
- **BE-IOT-03**（幂等层）：幂等键建议使用 `iotTopic` + Payload `meta.messageId`（CT-03 meta 契约）。

## 5. 未决风险

- IoT Rules SQL 2016-03-23 的 `SELECT *` 平铺存在极端键碰撞风险（设备 Payload 顶层出现 `iotTopic` 等保留名会被 Rule 注入值覆盖还是冲突取决于引擎行为）；CT-03 上行 Schema 均为封闭 meta/data 结构，正常流量无顶层杂散键，残留风险由 BE-IOT-02 校验阶段兜底隔离；
- 非 JSON Payload 会被 Rule 引擎拒绝并进入 Error 队列（由运维巡检，暂无自动告警）。
