# BE-CERT-03 管理员证书轮换发起 API

> 2026-10-01 实施更新：管理员请求保持原路由、授权和幂等；PENDING 请求现在仅在新证完成 MQTT Heartbeat 与 REST Sync 双通道验证后，与撤销旧证同事务变为 COMPLETED，单个 Heartbeat 不再完成请求。 当前协议见 [设备 API 文档](../api/README.md)；下文较早验收记录保留历史，发生冲突时以本次更新和当前契约为准。

实现：[certificate-rotation](../../apps/cloud-api/src/admin/certificate-rotation)；契约：[admin-certificate-rotation-api.json](../../contracts/rest/admin-certificate-rotation-api.json)；测试：[admin-certificate-rotation.test.ts](../../apps/cloud-api/test/admin-certificate-rotation.test.ts)（PGlite）、[outbox-publisher.test.ts](../../apps/ingestion-worker/test/outbox-publisher.test.ts)（设备 Topic 下发）、[rotation-confirmation.test.ts](../../apps/ingestion-worker/test/rotation-confirmation.test.ts)（完成联动）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CERT-03（P2 / 管理后台后端与设备协同），依赖 BE-CERT-01、CT-04、AUTH-01、DOM-03（均已交付） |
| 端点 | `POST /api/v1/admin/devices/{deviceId}/certificate-rotation-requests`（Cognito + `certificate:rotate`） |
| 权限 | AUTH-01 矩阵新增 `certificate:rotate`，唯一持有者 PlatformSuperAdmin（授权安全角色）；矩阵测试已锁定 |
| 数据 | 新表 `certificate_rotation_requests`（migration `20260827170000`）+ 部分唯一索引：每设备至多一个 PENDING |
| 通知 | CT-04 `CERTIFICATE_ROTATION_REQUIRED` 与请求同事务写 Outbox，再由真实 Publisher 经 IoT Data Plane QoS 1 发布到 `bnx/device/{deviceId}/notification` |
| 功能边界 | 管理端不生成/下载设备私钥；设备经 BE-CERT-02 自行轮换领取；非强制换证 |

## 2. 处理链

1. 资格校验：设备存在（404）；生命周期 ∈ {Onboarded, Active, Suspended}（Retired/Onboarding 中 → 409 DEVICE_STATE_NOT_ALLOWED）；须有 ACTIVE 证书（全撤销/无证书 → 409 CONFLICT）；
2. 幂等：已有 PENDING 请求 → 200 重放原请求，不重复创建/通知；并发发起由部分唯一索引兜底（P2002 → 回读胜出记录）；
3. 单事务：创建请求（notifiedAt）+ Outbox 事件 + `CERT_ROTATION_REQUEST` 审计（actorId/actorRole/afterValue）；
4. 完成联动：BE-CERT-02 MQTT Heartbeat 与 REST Sync 双通道确认同事务将 PENDING 请求置 COMPLETED。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 合法请求生成一次通知 | 201 + Outbox 恰一条（类型/Topic 断言）+ 审计 | ✅ |
| 重复点击不创建多个有效请求 | 二次点击 200 同 requestId，请求/通知计数恒为 1；并发双发起恰一个 201 | ✅ |
| Retired/撤销证书设备按规则拒绝 | Retired/Onboarding 中 → 409 DEVICE_STATE_NOT_ALLOWED；仅撤销/无证书 → 409 CONFLICT；未知设备 404 | ✅ |
| 授权安全角色限定 | PlatformOperator 403、未认证 401；矩阵测试锁定 certificate:rotate 仅 PlatformSuperAdmin | ✅ |
| 管理端响应/日志无私钥 | 响应与审计序列化扫描无 privateKey/certificatePem/PEM 标记 | ✅ |
| 完成联动 | 首 Heartbeat 确认后 PENDING → COMPLETED（completedAt） | ✅ |

复验命令：`pnpm vitest run apps/cloud-api/test/admin-certificate-rotation.test.ts apps/ingestion-worker/test/outbox-publisher.test.ts apps/ingestion-worker/test/rotation-confirmation.test.ts`；全仓严格 Gate：`pnpm verify`。管理响应使用通用 OpenAPI validator 校验完整 body。

## 4. 对接说明

- **下行分发**：真实 `OutboxPublisherFn` 消费 `outbox_events`，使用账号 IoT Data Endpoint 发布 MQTT notification；IAM 仅允许 endpoint discovery 与设备 notification Topic；
- **设备端**：收到通知后经 BE-CERT-02 `POST /api/v1/device/certificate/rotate` 完成轮换；
- **BE-CERT-01**：管理端/设备端均可查询证书状态观察窗口进度。

## 5. 未决风险

- SUPERSEDED 状态已入契约但暂无置位路径（重新发起/管理员撤销请求场景待后续任务定义）；
- 目标 AWS 中的 EventBridge → Outbox → IoT Data Plane → 实机收包回执尚未执行；本地已验证事务行到唯一设备 Topic 的消息结构与状态迁移；
- 无轮换超时升级机制（设备长期不轮换不告警；属功能边界外的运维能力）。

## 6. 验收层级

| 层级 | 当前状态 |
|---|---|
| 模块验证 | 幂等请求、权限、事务 Outbox、完整 OpenAPI 响应和完成联动通过 |
| 生产接线 | Admin API 路由、Outbox Publisher entry、IoT Data Plane sender 与最小权限已接线 |
| 本地严格验收 | operationId/生产路由双向 Gate、真实 Lambda asset Gate、CDK 断言通过 |
| 目标 AWS 运行验收 | 尚未执行；发布前补 EventBridge、IoT 权限允许/拒绝及设备收包证据 |
