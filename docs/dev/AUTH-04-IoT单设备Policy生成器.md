# AUTH-04 IoT 单设备 Policy 生成器

实现：[packages/aws-clients/src/iot-device-policy.ts](../packages/aws-clients/src/iot-device-policy.ts)；测试：[iot-device-policy.test.ts](../packages/aws-clients/test/iot-device-policy.test.ts)（模板 + 允许/拒绝矩阵 9 项）、[topic-parity.test.ts](../packages/aws-clients/test/topic-parity.test.ts)（CT-02 一致性）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | AUTH-04（P0 / IoT 安全开发），依赖 CT-02、IAC-01（均已交付） |
| 落点 | `@fdp/aws-clients`：纯 JSON 策略文档构造，无 AWS SDK 调用（CreatePolicy/AttachPolicy 由 BE-ONB-03 执行） |
| Topic 事实源 | `contracts/mqtt/topic-catalog.json`（8 上行 + 3 下行），一致性由 parity 测试强制 |
| 功能边界 | 不负责批量设备制造与 JITR/JITP；不执行需要云凭据的动作 |

## 2. 策略结构（每 Thing 一份，4 条 Allow 声明）

| Sid | Action | Resource（字面量 ARN，零通配符） |
|---|---|---|
| ConnectAsSelf | `iot:Connect` | `client/{thingName}` —— 强制 Client ID = Thing Name |
| PublishOwnUplink | `iot:Publish` | `topic/bnx/device/{thingName}/{heartbeat,telemetry,report,alarm,event,ack,tamper,media}` |
| SubscribeOwnDownlink | `iot:Subscribe` | `topicfilter/bnx/device/{thingName}/{cmd,ota,notification}` |
| ReceiveOwnDownlink | `iot:Receive` | `topic/bnx/device/{thingName}/{cmd,ota,notification}` |

- 设备发布下行 Topic、订阅/接收其他设备 Topic 在结构上无授权路径；
- 输入校验：Thing Name 含通配符/分隔符、非法 Region/Account ID 直接抛错；
- 策略名 `fdp-device-{thingName}`，便于审计与回收。

## 3. 验收基准与证据

| 验收基准 | 证据 |
|---|---|
| 自身允许矩阵全部通过 | 本地求值器：Connect 自身、Publish ×8 上行、Subscribe/Receive ×3 下行全允许（3 项测试） |
| 跨设备/通配发布/错误方向全部拒绝 | 本地求值器拒绝矩阵：他机 Connect/Publish/Subscribe/Receive、`+`/`#` 通配、发布下行、订阅上行、未知类型、相邻路径（4 项测试） |
| 模板正确性 | 恰好 4 条 Allow；资源/Action 零通配符；Connect 锁定 Client ID = Thing Name（2 项测试） |

**边界说明**：验收基准中「被 AWS IoT 拒绝」的端到端证明需要真实云凭据（本任务禁止执行）。本任务以本地最小 IAM 求值器做静态语义证明——策略资源全部为字面量 ARN（无通配符），精确匹配求值与 AWS IoT 授权语义等价；真实环境拒绝矩阵归 QA-04/部署冒烟验证。

`pnpm vitest run packages/aws-clients` 14/14 通过；全仓 `pnpm verify` 退出 0（2026-08-27）。

## 4. 对接说明（下游任务）

- **BE-ONB-03**（发证）：每台设备 `CreatePolicy(buildDevicePolicy({region, accountId, thingName}))` → `AttachPolicy` 到设备证书；
- **IAC-01**：API Lambda 已持有 IoT 发放动作白名单（CreatePolicy/AttachPolicy 等）；Region/Account 在运行时由 `AWS_REGION` 与 STS Caller Identity 提供；
- **QA-04**：模拟器使用独立 Thing/证书时，以同一生成器产出 Policy，保证模拟与生产策略一致。

## 5. 未决风险

- 本地求值器只覆盖字面量匹配语义；AWS IoT 真实评估还受 Thing Group 附加策略、账户级配额影响，首台真实设备接入时需人工复核一次拒绝矩阵；
- 单设备单 Policy 在 10k+ 设备时产生策略数量膨胀；试运营规模（百级）无虞，规模化前评估迁移到 Thing Group + 策略变量（`${iot:Connection.Thing.ThingName}`）模式。
