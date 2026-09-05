# BE-OTA-03 OTA MQTT 下发与状态接收

实现：[apps/cloud-api/src/ota](../apps/cloud-api/src/ota)（publisher/ack-handler）；BE-OTA-02 [ota-campaign/service.ts](../apps/cloud-api/src/admin/ota-campaign/service.ts) 取消流程补充 OTA_CANCELLED 通知；验收测试 [ota-dispatch.test.ts](../apps/cloud-api/test/ota-dispatch.test.ts)（10 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-OTA-03（P2 / 后端业务），依赖 BE-OTA-02（状态机/recordTargetStatus）、CT-02（topic-catalog）、CT-03（ota/ack/notification schema）、AUTH-04（IoT 单设备 Policy：设备只能发到自己的 Topic）、IAC-01、DEC-015、DEC-016 |
| 事实源 | CT-03 `bnx/device/{deviceId}/ota`（downlink QoS1）+ `notification` + `ack`（uplink）；DEC-015@1.0.0（ACK 为唯一回传通道，objectType=OTA_TARGET + otaTargetId，状态集合 DOWNLOADING/INSTALLING/SUCCEEDED/FAILED/ROLLED_BACK）；DEC-016@1.0.0（OTA 以 OPERATION_RECORD PUBLICATION/RESULT 归档，禁止伪装 MQTT 原文）；关键问题 §4.10（预签名 URL 15 分钟） |
| 功能边界 | 不实现设备端下载和安装；COMMAND 类 ACK 属 BE-CMD-03 |

## 2. 关键设计

**下发（Publisher）**：`dispatchOtaCampaign` / `dispatchPendingOtaTargets`（部署层定时器/事件入口，注入 `OtaMqttPublisher` + `OtaDownloadUrlSigner` 端口）：
- 仅消费 **RUNNING** Campaign 的 **PENDING** 且到期（scheduledTime ≤ now）target → 暂停/取消后不得产生新下发；
- 下发前二次防护：包必须仍为 VERIFIED、设备非 Retired；
- 每个目标生成 **15 分钟（900s）预签名下载 URL**：与目标设备/包绑定（只投递 `bnx/device/{deviceId}/ota` 目标设备 Topic，URL 内嵌包 objectKey，过期不可用）；
- Payload 符合 CT-03 ota.schema.json（version/packageType/downloadUrl/sha256/mandatory/scheduledTime），`mandatory=false`（试运营禁止强制升级），**meta.id = `OTA-{otaTargetId大写}`**（DEC-006 幂等键，CT-03 metaBase 大写模式）；
- 至少一次投递：MQTT 成功后才迁移 PENDING→NOTIFIED（复用 BE-OTA-02 recordTargetStatus），失败保持 PENDING 下次重投且幂等键稳定；
- 成功后写 **OTA_AVAILABLE** 通知（Outbox，deviceAction=AWAIT_OTA_MESSAGE）与 **DEC-016 PUBLICATION** 归档记录（Outbox ARCHIVE/OPERATION_RECORD，customerId 取设备归属、缺失回退有效 License 所属）。

**OTA_CANCELLED**：BE-OTA-02 取消流程级联 CANCELLED 时，对已通知（NOTIFIED/DOWNLOADING/INSTALLING）的 target 写 OTA_CANCELLED 通知（Outbox，action=CANCEL_PENDING_OTA）；PENDING 未通知过设备不发取消通知。

**状态接收（ACK Handler）**：`handleOtaAck`（部署层 IoT Rule/Lambda 消费 ack 上行 Topic，Envelope 已由 ack.schema.json 校验）：
- 判别：`objectType=OTA_TARGET` + `otaTargetId`；COMMAND 移交（handled=false）；**COMMAND 专属字段（commandId/command/result/executeTimeMs）混带一律拒绝**（DEC-015 禁止混用）；
- 设备绑定：Topic deviceId（AUTH-04 保证）必须等于 target.deviceId，否则拒绝且无副作用；
- 状态迁移经 recordTargetStatus（封闭迁移表 + 并发兜底）；**重复上报幂等**（同状态重放不写历史/归档）；迟到 ACK（target 终态/取消）不产生状态变化；
- 每次被接受的状态变化写 **DEC-016 RESULT** 归档（data.source 固定 `DEC-015_ACK_OTA_TARGET`，含 ackId/errorCode/message）；
- 全部 target SUCCEEDED 时由 recordTargetStatus 自动完成 Campaign。

## 3. 验收基准与证据（vitest + PGlite，10 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 非目标设备不能下载 | OTA 载荷只投递目标设备 Topic；非目标设备 ACK 回报被拒绝（DEVICE_MISMATCH）且状态不变 | ✅ |
| URL 过期不可用 | 15 分钟（900s）过期时点精确断言；部署层签名器按同一 TTL 实现 | ✅ |
| 选定通道状态迁移与重复上报幂等 | DOWNLOADING→INSTALLING→SUCCEEDED 逐条历史 + 每步 RESULT 归档；同状态重放 replayed 且不重复历史/归档；非法跳阶段/未知状态/缺关联键拒绝 | ✅ |
| 不存在第二条未登记回传通道 | topic-catalog 断言：ota 仅 downlink，无 ota 上行/status Topic；ACK 为唯一上行通道 | ✅ |
| 取消后设备获得正确 Notification | 已通知设备收 OTA_CANCELLED（action=CANCEL_PENDING_OTA，含 otaTargetId）；PENDING 设备不发 | ✅ |
| 暂停/取消不产生新下发 | PAUSED/CANCELLED/包 RETIRED/设备 Retired/未到期均 0 发布 | ✅ |
| 失败重投幂等 | MQTT 失败保持 PENDING；重投 meta.id 稳定不变；NOTIFIED 后不重复投递 | ✅ |
| Payload 契约 | 构建载荷经 CT-03 ota.schema.json + validator.mjs 校验通过 | ✅ |

## 4. 未决风险

- **部署层接线**：IoT Data Plane 发布器、S3 presigned GET（15 分钟）、Outbox 下行分发器与 ACK Ingress（IoT Rule → Lambda 调 handleOtaAck）由部署/运维任务接线；本任务无 AWS 依赖。
- **至少一次投递语义**：MQTT 成功但 DB 写失败会重投（meta.id 稳定，设备端按幂等键去重——设备侧职责，见关键问题 §4.10 边界划分）。
- **OTA_AVAILABLE 与 ota 载荷的到达顺序**：通知经 Outbox 异步分发，可能晚于 ota Topic 载荷；deviceAction=AWAIT_OTA_MESSAGE 为建议性动作，设备端需容忍乱序。
- **签名机制未冻结**（BE-OTA-01 风险延续）：VERIFIED 包在签名策略冻结前无法产生，本链路端到端可用性依赖该决策冻结。
