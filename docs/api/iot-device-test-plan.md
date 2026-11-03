# 上位机 MQTT 接口测试方案

适用范围为 [设备 MQTT 联调说明](./iot.bio-nexa.com.md) 的 8 类上行和 3 类下行。[Onboarding](./onboard-api.bio-nexa.com.md) 和 [Device REST](./device-api.bio-nexa.com.md) 仅覆盖完成 MQTT 闭环所需的操作。

## 测试准备

- 上位机方准备待测软件版本、隔离台架、可控断网和重启条件、正确的 UTC 时钟，以及设备与动作日志。云端方准备测试设备库存、审批、Customer/Site、适用的 License/Entitlement、下行发布权限和日志查询能力。
- 主用设备跑接入与正常链路。挂起、退役、证书轮换、OTA 和高风险实体动作使用隔离设备或可恢复台架，分别准备所需的设备状态、包和恢复手段。
- 使用 Onboarding 返回及运维确认的 MQTT 主机和信任根，TLS 8883，SNI 同主机，Client ID 原样使用 `deviceId`。业务消息 QoS 1，Retain 关闭。同一 Client ID 只运行一个连接。
- 参考 [完整报文样例](./mqtt-message-examples.md) 离线校验。发送时换用当前 UTC 时间、真实业务 ID 和持久化的递增序号。Telemetry、Report、Tamper 在字段确定后按 JCS 对 `{meta,data}` 算 SHA-256。

## 第一轮：接入与基本业务

依序执行 01–07。01–04 任一步未通过，暂停依赖该步骤的用例。05–07 各链路单独记录结果。

| 编号 | 上位机与云端操作 | 通过条件 |
|---|---|---|
| 01 | 上位机生成密钥和 CSR，云端审批，上位机领取并安装证书链 | 取得真实设备 ID 与端点；证书和本地私钥匹配 |
| 02 | 建立 MQTT 连接，在同一连接订阅自身 `cmd`、`ota`、`notification` | TLS、CONNACK 和三个 SUBACK 成功 |
| 03 | 发布首条合法 `heartbeat`，等待云端确认 | 云端设备进入 `Onboarded`、证书记录为 `ACTIVE`；记录在线状态 |
| 04 | 用同一叶证书调用 `POST /api/v1/device/sync`；云端完成 Customer/Site 分配后再次同步 | 取得并核对归属、配置、License 和运行状态；上位机应用同步周期与上报间隔。需要业务许可的后续用例，以实际 License/Entitlement 和设备状态为前置 |
| 05 | 连续上报 `heartbeat` 与 `telemetry`，再发送一条完整周期的 `report` | 云端在线状态更新、Telemetry 和 Report 处理及归档成功；频率按 Sync 配置，报告周期与台架数据相符 |
| 06 | 触发 `alarm`，按同一 code 用新序号发送 `CLEARED`；触发一条 `event`；上报带 Hash 的低严重度 `tamper` | 告警激活并解除；操作事件独立记录；安全事件被处理且该设备仍可继续基本联调 |
| 07 | 云端调整测试配置并发送 `notification`（`CONFIG_CHANGED`）；上位机接收后发起 Sync | 云端与上位机的配置一致；观察 Heartbeat 或 Telemetry 实际发送间隔变化 |

## 第二轮：命令、媒体和升级闭环

完成接入与基础上报后，先跑命令与媒体，再在独立台架跑 OTA。下行由云端发布器生成，上位机使用真实任务标识回执。

| 编号 | 操作 | 通过条件 |
|---|---|---|
| 08 | 云端先发 `FORCE_SYNC` 验证 `cmd → ack`，再执行获准的台架动作；构造失败、过期和重复下行 | `ack.data.objectType=COMMAND`，原 `cmd.meta.id` 原样填入 `commandId`，命令名一致。若发收到确认，之后用新 ACK 序号发最终结果。云端状态与上位机行为一致；过期和重复命令不触发动作，迟到回执不改写终态 |
| 09 | 采集测试图片，调用 REST 创建媒体上传会话，按预签名 URL PUT 文件，再发 `media` | 使用返回的原始 `objectPath`，云端核对归属、文件大小和 Hash。另测非法路径与过期会话 |
| 10 | 云端下发 `ota`；上位机从下载 URL 路径解码原始 `otaTargetId`，用 mTLS 兑换授权，跟随 307 下载并核对 SHA-256，再安装 | 使用 `objectType=OTA_TARGET` 回执 `DOWNLOADING → INSTALLING → SUCCEEDED`，各阶段用新 ACK 序号；检查安装后的实际版本。另用独立任务测试过期授权、摘要不符及适用的失败/回滚路径，摘要不符时不进入安装 |
| 11 | 展开命令与通知矩阵 | 按接口文档逐项记录 22 种命令和 13 类通知的适用状态、实机动作或 REST 请求及结果。涉及参数语义未定的命令保留 `BLOCKED`，例如 `SET_TARGET_TEMPERATURE` 的设备执行策略；高风险动作按台架条件单独验收 |

## 第三轮：异常、重启和生命周期

| 编号 | 操作 | 通过条件 |
|---|---|---|
| 12 | 分别尝试错误 Client ID、跨设备发布/订阅、通配订阅、设备发布下行；然后用合法连接发缺字段、额外身份字段、错 Hash、超时间窗报文 | 越权操作被拒绝；非法报文由云端判定并隔离，无业务写入。每组异常后用合法报文确认链路恢复 |
| 13 | 在时间窗内原样重发上行，再用同类型同 seq 改内容；断网重连、重启上位机并复投已完成的命令 | 原样重发只处理一次；改内容产生 `PAYLOAD_CONFLICT`，原记录保留。重连有退避、恢复三个订阅并执行 Sync；各上行类型序号及下行执行记录跨重启保留，过期离线报文按队列策略处理 |
| 14 | 隔离设备触发证书轮换，用新证分步验证 Heartbeat 与 REST Sync；另建用例验证超时回退 | 单通道完成时旧证仍有效；双通道确认后旧证应用访问被拒绝，后续核对 Broker 停用。超时未确认时新证撤销、旧证保留 |
| 15 | 隔离设备触发符合条件的 `CRITICAL` Tamper 或云端挂起，观察上位机进入挂起模式；退役放到该设备用例最后执行 | 挂起后停止业务和 ESG 上报，仍保留心跳、遥测及必要维护。退役后停止 MQTT 业务，按 REST Sync/Deactivate 完成确认；云端侧核对八类业务上行拒绝规则 |

## 判定与留证

- 按用例记录 `PASS`、`FAIL`、`BLOCKED` 或 `NOT_RUN`。缺云端证据、业务许可或台架条件时，记录具体缺项；报文模拟和真机执行分别留证。
- 每条证据记录环境、上位机版本、设备 ID、UTC 时间、Topic、消息 ID/seq、相关 commandId 或 otaTargetId、设备行为及云端处理结果。共享记录脱敏证书、私钥、下载 token 和预签名 URL。
- CONNACK、SUBACK 和 PUBACK 分别用于确认连接、订阅和 Broker 接收。业务验收另看云端处理记录、归档或状态迁移，以及上位机配置、版本或实体动作。逐项勾销用例后再汇总覆盖范围。
