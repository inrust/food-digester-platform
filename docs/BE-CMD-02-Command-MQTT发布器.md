# BE-CMD-02 Command MQTT 发布器

实现：[apps/cloud-api/src/admin/command/publisher.ts](../apps/cloud-api/src/admin/command/publisher.ts)（注入式 `CommandMqttPublisher` 端口，无 AWS 依赖——部署层接 IoT Data Plane）；验收测试：[command-publisher.test.ts](../apps/cloud-api/test/command-publisher.test.ts)（8 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CMD-02（P1），依赖 BE-CMD-01（AUTHORIZED 命令）、CT-03（topic-catalog/cmd.schema）、IAC-01（部署层接 IoT Data Plane，本模块不含） |
| Topic | CT-03：`bnx/device/{deviceId}/cmd`（`commandTopicOf`） |
| Payload | cmd.schema.json Envelope：`{meta:{id,ts}, data:{command,requestedBy,requestTime,timeoutSec,remarks?}}`，无 audit 域；meta.id = commandId（DEC-006 幂等键）；下行 meta.seq 可选，V1 不发送 |
| QoS | 目录 specified 2 → AWS 有效 QoS 1（`COMMAND_PUBLISH_QOS = 1`），决策引用 ADP-002@1.0.0（topic-catalog qosAdaptation；QoS 2→1 仅为 AWS 技术适配，不删除 ACK/超时/审计机制） |
| 功能边界 | 不等待设备同步响应、不推测执行成功（ACK/超时扫描属 BE-CMD-03）；无 REST 端点（交付物仅 Publisher + 测试，不新增 OpenAPI 契约） |

## 2. 发布流程与设计

`publishCommand(deps, commandId)`（`now` 可注入时钟）：

1. **发布前重校验**：命令不存在 → 404；设备 Retired → 409 DEVICE_STATE_NOT_ALLOWED（不发布）；`expiresAt` 已过 → 409 CONFLICT 'Command has expired'（超时后拒绝再次发布，不发消息、不落 attempt、状态不动）；
2. **幂等**：已 PUBLISHED → REPLAYED_PUBLISHED（不重复发消息、不新增 attempt）；非 AUTHORIZED/FAILED 状态 → 409；
3. **抢占**：条件 `updateMany(status in AUTHORIZED/FAILED → PUBLISHING)` 并发兜底，抢不到重读分类（并发已发布 → 重放）；
4. **执行**：`attemptNo = count(attempts)+1` 递增；`mqtt.publish({topic, payload, qos:1})`；
5. **结果落库**：成功 → attempts 落行 + 状态 PUBLISHED；异常 → attempts 落行 + 状态 FAILED（未过期可重试）。

**重试不创建新 commandId**：FAILED 重试沿用同一 commandId（meta.id 不变），attempts 逐行记录 attemptNo 递增；`device_commands` 无新行。schema 状态注释补充 PUBLISHING 中间态。

**BE-CMD-01 顺带对齐**（随本任务提交）：创建端 commandId 校验/生成对齐 DEC-006 meta.id 模式 `^[A-Z0-9][A-Z0-9-]{0,127}$`（客户端提供不符 → 400；缺省生成 `randomUUID().toUpperCase()`）；OpenAPI commandId 补 pattern 约束。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 在线合法设备收到正确 Topic/Payload | Fake MqttPublisher 断言 topic=`bnx/device/{deviceId}/cmd`、qos=1；Envelope meta.id=commandId、meta.ts、data 必填键与 cmd.schema.json required 一致、remarks 空省略、无 audit 域、无 seq | ✅ |
| 发布成功记录 Published | 状态 PUBLISHED + attempts attemptNo=1 落行 | ✅ |
| 过期命令不发布 | expiresAt 已过 → 409 CONFLICT，mqtt 0 调用、0 attempt、状态不变 | ✅ |
| Retired 命令不发布 | 409 DEVICE_STATE_NOT_ALLOWED，mqtt 0 调用、状态不变 | ✅ |
| 非可发布状态拒绝 | ACKNOWLEDGED/TIMED_OUT/CANCELLED/CREATED → 409；不存在 → 404 | ✅ |
| 发布重试不创建新 commandId | 首次发布异常 → FAILED（attemptNo=1）；重试成功 → PUBLISHED（attemptNo=2），同 commandId、device_commands 仅 1 行 | ✅ |
| 超时后拒绝再次发布 | FAILED 且已过期 → 409，不发消息 | ✅ |
| PUBLISHED 幂等重放 | REPLAYED_PUBLISHED，mqtt 仍 1 调用、attempts 仍 1 行 | ✅ |

## 4. 未决风险

- PUBLISHING 为进程内抢占中间态：进程崩溃可能滞留（BE-CMD-03 超时扫描或运维修复兜底；本任务不引入恢复任务）；
- mqtt.publish 抛错即记 FAILED，不区分可重试错误类型（部署层重试策略待定）；
- 下行 meta.seq 未启用（downlink-policy provisional，启用后需分配器）；
- Payload 序列化为模块内函数（cmd.schema.json 一致性由测试断言 required 键，未做完整 JSON Schema 校验）。
