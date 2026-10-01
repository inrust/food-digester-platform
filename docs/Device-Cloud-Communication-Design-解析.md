# Device-Cloud Communication Design 解析与信息汇编

> 2026-10-01 已批准协议覆盖：下文源文件中的 `certificatePem + privateKey` 和仅 Heartbeat 轮换确认是历史设计事实，不能作为现行协议。当前 Onboarding 返回公开叶证书、完整 CA chain 和 MQTT/REST endpoint；Rotate 接收设备新 CSR，仅返回叶证书及 chain，双通道确认后撤销旧证。见 [设备 API 文档](./api/README.md)、DEC-003@1.1.0 与 DEC-026@1.0.0。
> **2026-09-29 实施变更**：本文保留原始方案/来源记录；首次接入已统一改为无 Token 的 CSR 申请、管理员线下核验审批、CSR 私钥签名轮询及只下发公钥证书。本文关于预置 Onboarding Token、`onboarding_tokens` 表或首次下发私钥的描述不再是实施依据；以 [现行 Onboarding API](api/onboard-api.bio-nexa.com.md) 与 [可执行 OpenAPI](../contracts/rest/device-onboarding-api.json) 为准。

> 来源：[Device-Cloud Communication Design.pdf](<./Device-Cloud Communication Design.pdf>)（36 页）。本文页码均指 PDF 页序。
>
> 定位：本文是对源 PDF 的结构化提取，不代表仓库当前实现，也不替代 OpenAPI、MQTT Schema、决策登记或安全规范。源稿未明确、版面错位或前后不一致的内容统一收录于“待确认事项”。

## 1. 文档内容地图

| 页码 | 内容 |
|---|---|
| 1 | 封面 |
| 2 | 设备生命周期及状态迁移 |
| 3-5 | 商业生命周期、业务实体、设备运行生命周期 |
| 6 | 设备与云通信设计分隔页 |
| 7 | MQTT 与 HTTPS REST 通信架构 |
| 8-21 | MQTT 分层、Topic 目录、消息字段、命令和留存策略 |
| 22-27 | REST API、Onboarding、证书、统一同步及调用频率 |
| 28 | 业务场景与系统集成分隔页 |
| 29-32 | 13 个业务场景时序 |
| 33-34 | Onboarding 正向/异常流程及总流程图 |
| 35 | 底层数据库设计分隔页 |
| 36 | 仅有“Device Side Database Design (Android Edge)”标题，无表结构或字段定义 |

## 2. 核心设计结论

1. 设备运行时双向通信使用 MQTT；Onboarding、状态同步、证书等生命周期操作使用 HTTPS REST API。[p.7]
2. MQTT 使用设备 X.509 证书；REST API 在 Onboarding 前使用 QR/Onboarding Token，Onboarding 后使用 X.509 + mTLS。[p.7, p.22]
3. 云端状态变化通过 MQTT Notification 唤醒设备，再由设备调用 `POST /api/v1/device/sync` 拉取最新完整状态。[p.20, p.25-27]
4. `POST /api/v1/device/sync` 是 Assignment、License、Entitlements、Configuration、Device Users 和 Operational Status 的单一事实源。[p.25]
5. Onboarding 以首次成功 MQTT Heartbeat 作为完成标志，而不是以审批或证书领取作为完成标志。[p.22-23, p.29, p.33-34]
6. Suspended 设备停止业务处理和 ESG Reporting，但继续 Heartbeat、Telemetry、Alarm、License Sync、Remote Control、OTA 和 User Synchronization；Retired 设备全部停用。[p.5, p.26]

## 3. 业务对象与生命周期

### 3.1 业务实体

| 实体 | 含义 | 关系 | 示例 |
|---|---|---|---|
| Customer | 部署的商业所有者 | 拥有 Site、Device、Device User | ABC Hotel Group、DEF Food Court |
| Site | 物理安装位置 | 1 Customer 对多 Site；1 Site 对多 Device | Hotel A Kitchen、Hospital Main Kitchen |
| Device | 被管理的 Kitchen Machine | 隶属 Site；关联证书、分配、用户、配置、命令等 | DEV001、DEV002 |
| License | 与设备关联的商业授权 | 1 Device 对 1 个 Active License | 包含类型、有效期、Features、Status |
| Entitlement | License 授予的功能权利 | 1 License 对多个 Entitlement | Remote Control、OTA、ESG Reports |

源稿 ERD 还出现 `DEVICE_CERTIFICATE`、`DEVICE_ASSIGNMENT`、`DEVICE_USER`、`DEVICE_USER_ASSIGNMENT`、`DEVICE_CONFIGURATION`、`LICENSE_ENTITLEMENT`、`USER_ROLE`、`ROLE`、`USER`、`DEVICE_COMMAND`、`AUDIT_LOG` 等实体，但没有给出字段级数据库设计。[p.4]

### 3.2 设备生命周期

| 状态 | 含义 |
|---|---|
| `PendingOnboarding` | 设备已提交 Onboarding 请求 |
| `Rejected` | Onboarding 请求被拒绝 |
| `OnboardingApproved` | CMP 管理员已批准 |
| `Onboarded` | 已完成 Provisioning 并建立信任 |
| `Assigned` | 已分配 Customer 与 Site |
| `Licensed` | 有效 License 已同步到设备 |
| `Active` | 设备可运行 |
| `Suspended` | 设备受限运行 |
| `Retired` | 永久退役；此定义来自运行生命周期页，状态定义表本身未列出 |

状态迁移：[p.2]

| From | To | 触发事件 | 执行方 | 前置条件 |
|---|---|---|---|---|
| `PendingOnboarding` | `OnboardingApproved` | Approval | CMP Super Admin | Device validation passed |
| `PendingOnboarding` | `Rejected` | Reject onboarding | CMP Super Admin | Validation failed |
| `OnboardingApproved` | `Onboarded` | Provisioning completed | Device | Certificate installed |
| `Onboarded` | `Assigned` | Customer assigned | CMP Super Admin | Customer 与 Site 存在 |
| `Assigned` | `Licensed` | License issued and synchronized | CMP Super Admin | Active License available |
| `Licensed` | `Active` | Device validates license locally | Device | Valid License |
| `Active` | `Suspended` | Administrative or policy action | Admin/System | Suspension reason |
| `Suspended` | `Active` | Reactivation approved | Admin | Issue resolved |
| `Active` | `Retired` | Retirement process | CMP Super Admin | Device decommission approved |
| `Suspended` | `Retired` | Permanent removal | CMP Super Admin | Retire request approved |

### 3.3 商业生命周期

商业操作主链：[p.3]

```text
Registered Device
  -> Assign Customer
  -> Assign Site
  -> Create License
  -> Issue License
  -> Active License
  -> Operational
```

License 状态迁移：[p.3]

| From | To | 触发事件 |
|---|---|---|
| `NoLicense` | `Draft` | License created |
| `Draft` | `Issued` | License approved |
| `Issued` | `Active` | License synchronized and validated |
| `Active` | `ExpiringSoon` | 达到续期预警阈值 |
| `ExpiringSoon` | `Renewed` | Renewal approved |
| `Renewed` | `Active` | 设备收到更新后的 License |
| `ExpiringSoon` | `Expired` | 到达结束日期 |
| `Active` | `Revoked` | Admin revocation |
| `Expired` | `Revoked` | Contract terminated |

商业规则：[p.3]

| 条件 | 结果 |
|---|---|
| 已 Onboarded，未分配 Customer | 设备不可运行 |
| 已分配 Device，但无 License | 设备不可运行 |
| 已分配且已 Licensed | 设备可以进入 Active |
| License 过期 | 设备按策略进入受限行为 |

### 3.4 运行生命周期与功能矩阵

运行状态：[p.5]

| 状态 | 含义 |
|---|---|
| `Active` | 正常运行 |
| `Suspended` | 受限运行 |
| `Retired` | 永久退役 |

触发条件：[p.5]

| 事件 | 新状态 |
|---|---|
| Device commissioned | `Active` |
| License violation policy | `Suspended` |
| Security incident | `Suspended` |
| Lost/Stolen device | `Suspended` |
| End of life | `Retired` |

| 功能 | Active | Suspended | Retired |
|---|:---:|:---:|:---:|
| Local Login | 允许 | 允许 | 禁止 |
| Heartbeat | 允许 | 允许 | 禁止 |
| Telemetry | 允许 | 允许 | 禁止 |
| Alarm Reporting | 允许 | 允许 | 禁止 |
| License Sync | 允许 | 允许 | 禁止 |
| Remote Control | 允许 | 允许 | 禁止 |
| Device Processing | 允许 | 禁止 | 禁止 |
| ESG Reporting | 允许 | 禁止 | 禁止 |
| OTA Updates | 允许 | 允许 | 禁止 |
| User Synchronization | 允许 | 允许 | 禁止 |

## 4. 通信架构与安全边界

| 通道 | 用途 | 认证 |
|---|---|---|
| MQTT | Heartbeat、Telemetry、Alarm、Event、Command、OTA、Notification 等运行时通信 | Device X.509 Certificate |
| HTTPS REST | Onboarding、Sync、Certificate 及其他业务/生命周期操作 | Onboarding 前：QR/Onboarding Token；Onboarding 后：X.509 + mTLS |

REST API 公共约束：[p.22]

| 项 | 值 |
|---|---|
| Caller | Device（Android Edge Gateway） |
| Server | CMP |
| Protocol | HTTPS |
| 公共路径前缀 | `/api/v1/` |
| 目的 | Device Lifecycle、License、User、Configuration、Status Synchronization |

## 5. MQTT 契约

### 5.1 消息分层与公共结构

| Tier | 用途 | 完整性要求 | Payload 结构 |
|---|---|---|---|
| Tier 1 | Runtime Operational Data | Standard Integrity | `meta + data` |
| Tier 2 | ESG / Audit Evidence | Enhanced Integrity | `meta + audit + data` |
| Tier 3 | Device Control | Command Traceability | `meta + data` |

公共 Envelope：[p.8]

```json
{
  "meta": {
    "id": "RPT-DEV001-50001",
    "ts": "2026-08-01T23:59:59Z",
    "seq": 50001
  },
  "audit": {
    "hash": "sha256(payload)"
  },
  "data": {}
}
```

| Block | 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `meta` | `id` | String | 是 | 唯一消息 ID；格式 `{Topic type}-{DeviceId}-{SeqNo}` |
| `meta` | `ts` | ISO 8601 String | 是 | 设备生成的事件时间 |
| `meta` | `seq` | Long | Tier 1/2 | 设备消息序号 |
| `audit` | `hash` | String | Tier 2 | Payload 内容的 SHA-256 Hash |
| `data` | 自定义字段 | - | - | 由设备端或云端 CMP 按 Topic 定义 |

### 5.2 Topic 目录

#### Device -> Cloud

| 类型 | Topic | 目的 | 频率 | QoS | 源稿 Tier / Payload |
|---|---|---|---|---:|---|
| Heartbeat | `bnx/device/{deviceId}/heartbeat` | 健康及在线监控 | 每 60 秒 | 1 | Tier 1 / `meta + data` |
| Telemetry | `bnx/device/{deviceId}/telemetry` | ESG 传感器源数据 | 10-60 秒，可配置 | 1 | Tier 1 / `meta + audit + data` |
| ESG Report | `bnx/device/{deviceId}/report` | ESG 报告 | 每 Cycle / Hour / Day | 2 | Tier 1 / `meta + audit + data` |
| Alarm | `bnx/device/{deviceId}/alarm` | 故障与报警 | 事件触发 | 1 | Tier 1 / `meta + data` |
| Event | `bnx/device/{deviceId}/event` | 运行审计事件 | 事件触发 | 1 | Tier 1 / `meta + data` |
| ACK | `bnx/device/{deviceId}/ack` | 命令执行回执 | 命令执行后 | 1 | Tier 1 / `meta + data` |
| Tamper（可选） | `bnx/device/{deviceId}/tamper` | 安全与篡改证据 | 事件触发 | 2 | Tier 1 / `meta + audit + data` |
| Media | `bnx/device/{deviceId}/media` | 图片/视频上传通知 | 事件触发 | 1 | Tier 1 / `meta + data` |

#### Cloud -> Device

| 类型 | Topic | 目的 | 频率 | QoS | 源稿 Tier / Payload |
|---|---|---|---|---:|---|
| Command | `bnx/device/{deviceId}/cmd` | 远程设备操作 | 按需 | 2 | Tier 1 / `meta + data` |
| OTA | `bnx/device/{deviceId}/ota` | 软件/固件升级触发 | 按需 | 1 | Tier 1 / `meta + data` |
| Notification | `bnx/device/{deviceId}/notification` | 业务状态变化通知 | 按需 | 1 | Tier 1 / `meta + data` |

### 5.3 Heartbeat 参数

Heartbeat 用于在线状态、设备运行状态、License、网络、资源、传感器和安全健康检查。[p.10]

| 分类 | 字段 | 类型 | 必填 | 示例/枚举 | 说明 |
|---|---|---|:---:|---|---|
| Device | `deviceStatus` | Enum | 是 | `ONLINE` / `DEGRADED` / `OFFLINE` | 连接状态 |
| Device | `uptimeSeconds` | Long | 是 | `86400` | 启动时长 |
| Device | `firmwareVersion` | String | 是 | `1.0.5` | 当前软件版本 |
| Operational | `operationalStatus` | Enum | 是 | `ACTIVE` / `SUSPENDED` / `RETIRED` | 运行生命周期状态 |
| Operational | `machineRunning` | Boolean | 是 | `true` | 是否正在运行 |
| Operational | `machineMode` | Enum | 是 | `IDLE` / `PROCESSING` / `HEATING` / `DISCHARING` / `STOPPED` / `ERROR` | 当前模式；`DISCHARING` 为源稿拼写 |
| License | `licenseStatus` | Enum | 是 | `ACTIVE` / `EXPIRING` / `EXPIRED` / `REVOKED` | License 状态 |
| License | `licenseExpiryDate` | Date | 否 | `2027-12-31` | License 到期可见性 |
| Network | `networkType` | Enum | 是 | `4G` | 网络类型 |
| Network | `networkStatus` | Enum | 是 | `CONNECTED` / `WEAK` / `DISCONNECTED` | 网络状态 |
| Network | `signalStrength` | Integer | 否 | `-68` | 蜂窝/Wi-Fi 信号 |
| System | `cpuUsagePct` | Number | 否 | `25` | CPU 利用率 |
| System | `memoryUsagePct` | Number | 否 | `40` | 内存利用率 |
| System | `storageUsagePct` | 源稿缺失 | 源稿错位 | `30` | 存储利用率 |
| Sensors | `sensorOverallStatus` | Enum | 是 | `NORMAL` / `WARNING` / `FAILED` | 传感器总体健康 |
| Sensors | `temperatureSensor` | Enum | 否 | `NORMAL` / `WARNING` / `FAILED` | 温度传感器健康 |
| Sensors | `humiditySensor` | Enum | 否 | `NORMAL` / `WARNING` / `FAILED` | 湿度传感器健康 |
| Sensors | `weightSensor` | Enum | 否 | `NORMAL` / `WARNING` / `FAILED` | 重量传感器健康 |
| Sensors | `gasSensor` | Enum | 否 | `NORMAL` / `WARNING` / `FAILED` | 气体传感器健康 |
| Security | `certificateStatus` | Enum | 否 | `VALID` / `EXPIRING` / `EXPIRED` / `REVOKED` | 证书健康 |
| Security | `tamperStatus` | Enum | 否 | `NORMAL` | 设备完整性状态 |

源稿 JSON 示例将若干概念字段改为嵌套结构，例如 `network.type/status/signal`、`system.cpuUsage/memoryUsage/storageUsage`、`machine.running/currentMode` 和 `sensorStatus.*`；与上表字段名并不完全一致，见待确认事项。

### 5.4 Telemetry 参数

用途：实时监控、ESG 计算源数据、趋势分析和数据分析。[p.11]

| 分类 | 字段 | 示例 | 说明 |
|---|---|---:|---|
| Process | `feedingWeightKg` | 25 | 当前输入重量 |
| Process | `chamberWeightKg` | 120 | 当前腔体重量 |
| Process | `dischargeWeightKg` | 5 | 当前排出重量 |
| Environment | `humidityPct` | 45.2 | 湿度 |
| Environment | `ambientTempC` | 28.5 | 环境温度 |
| Heat | `heatTemperatureC` | 72.1 | 加热器温度 |
| Heat | `siloTemperatureC` | 62.5 | 筒仓温度 |
| Energy | `powerConsumptionKw` | 2.8 | 实时功耗 |
| Gas | `o2Pct` | 20.5 | 氧气浓度 |
| Gas | `co2Ppm` | 420 | 二氧化碳浓度 |
| Gas | `ch4Ppm` | 12 | 甲烷浓度 |
| Gas | `n2oPpm` | 1.5 | 氧化亚氮浓度 |
| Motor | `currentAmp` | 3.8 | 电机电流；JSON 示例使用 `motorCurrentAmp` |

源稿未提供这些字段的类型、必填性、量程、精度和采样时间语义。

### 5.5 ESG Report 参数

报告粒度包括 Cycle、Hourly 和 Daily，作为 ESG 业务证据。[p.12]

| 分类 | 字段 | 示例 | 说明 |
|---|---|---|---|
| Report | `reportType` | `DAILY` | `CYCLE` / `HOURLY` / `DAILY` |
| Report | `periodStartTime` | `2026-08-01T00:00:00Z` | 报告开始时间 |
| Report | `periodEndTime` | `2026-08-01T23:59:59Z` | 报告结束时间 |
| Throughput | `feedingWeightKg` | 250 | 总输入重量 |
| Throughput | `dischargeWeightKg` | 180 | 总输出重量 |
| Throughput | `reductionWeightKg` | 70 | 减重 |
| Processing | `cycleCount` | 12 | 完成 Cycle 数 |
| Processing | `processingDurationMinutes` | 480 | 处理时长 |
| Energy | `energyConsumptionKwh` | 18.5 | 总耗电量 |
| Energy | `averagePowerKw` | 2.4 | 平均功率 |
| Gas | `averageO2Pct` | 20.4 | 平均 O2 |
| Gas | `averageCo2Ppm` | 430 | 平均 CO2 |
| Gas | `averageCh4Ppm` | 11 | 平均 CH4 |
| Gas | `averageN2oPpm` | 1.4 | 平均 N2O |
| ESG | `carbonReductionKg` | 35.6 | 计算出的碳减排量 |
| ESG | `carbonReductionMethod` | `DEFAULT_V1` | 计算方法 |
| Quality | `dataCompletenessPct` | 99.8 | 数据完整度 |
| Quality | `missingRecordCount` | 2 | 缺失 Telemetry 记录数 |

### 5.6 Alarm、Event、ACK、Tamper、Media 参数

Alarm 是需要采取行动的异常，不是普通传感器读数；适用于设备故障、维护、安全事件和升级处理。[p.13]

| Topic | 字段 | 示例 | 说明 |
|---|---|---|---|
| Alarm | `code` | `TEMP_HIGH` | Alarm Code |
| Alarm | `category` | `TEMPERATURE` | 分类 |
| Alarm | `severity` | `HIGH` | `INFO` / `WARNING` / `HIGH` / `CRITICAL` |
| Alarm | `status` | `ACTIVE` | `ACTIVE` / `CLEARED` |
| Alarm | `detectedTime` | `2026-08-01T10:15:00Z` | 检测时间 |
| Alarm | `component` | `HEATER` | 故障组件 |
| Alarm | `currentValue` | 88 | 当前值 |
| Alarm | `threshold` | 80 | 阈值 |
| Alarm | `unit` | `C` | 测量单位 |
| Alarm | `message` | `Heating temperature exceeded threshold` | 人类可读消息 |
| Alarm | `recommendedAction` | `CHECK_HEATER` | 维护建议 |
| Event | `eventType` | `MACHINE_STARTED` | 事件类型 |
| Event | `userId` | `USR001` | 操作员 ID |
| Event | `username` | `operator01` | 操作员账号 |
| Event | `source` | `LOCAL` | `LOCAL` / `REMOTE` |
| Event | `remarks` | `Daily operation start` | 自由文本 |
| ACK | `commandId` | `CMD-DEV001-6001` | 关联命令 |
| ACK | `command` | `START` | 已执行命令 |
| ACK | `result` | `SUCCESS` | `SUCCESS` / `FAILED` |
| ACK | `executeTimeMs` | 523 | 执行耗时 |
| ACK | `errorCode` | `null` | 失败错误码 |
| ACK | `message` | `Machine Started` | 执行结果 |
| Tamper | `eventType` | `ROOT_DETECTED` | 安全事件 |
| Tamper | `severity` | `CRITICAL` | 严重程度 |
| Tamper | `component` | `ANDROID_OS` | 受影响组件 |
| Tamper | `details` | `Root binary detected` | 详细描述 |
| Tamper | `actionTaken` | `DEVICE_SUSPENDED` | 自动响应 |
| Media | `mediaType` | `IMAGE` | `IMAGE` / `VIDEO` |
| Media | `captureTime` | `2026-08-01T12:04:55Z` | 原始采集时间 |
| Media | `fileName` | `snapshot.jpg` | 文件名 |
| Media | `objectPath` | `s3://bucket/path` | 云存储路径 |
| Media | `sizeKb` | 512 | 文件大小 |
| Media | `durationSec` | 0 | 视频时长；图片为 0 |

### 5.7 Command 参数与命令字

Command 数据参数：[p.18]

| 字段 | 示例 | 说明 |
|---|---|---|
| `command` | `START` | 命令名 |
| `requestedBy` | `tenant_admin` | 发起者 |
| `requestTime` | `2026-08-01T10:00:00Z` | 原始请求时间 |
| `timeoutSec` | 30 | 执行超时 |
| `remarks` | `Start processing batch` | 可选备注 |

| 分类 | 命令 | 说明 |
|---|---|---|
| Machine Operation | `START` | 开始处理 Cycle |
| Machine Operation | `STOP` | 停止处理 Cycle |
| Machine Operation | `PAUSE` | 暂停处理 |
| Machine Operation | `RESUME` | 恢复处理 |
| Machine Operation | `EMERGENCY_STOP` | 立即停止 |
| Heating | `HEATING_ON` | 开启加热 |
| Heating | `HEATING_OFF` | 关闭加热 |
| Heating | `SET_TARGET_TEMPERATURE` | 设置目标温度 |
| Discharge | `DISCHARGE_START` | 开始排放 |
| Discharge | `DISCHARGE_STOP` | 停止排放 |
| Motor | `AGITATOR_FORWARD` | 正向旋转 |
| Motor | `AGITATOR_REVERSE` | 反向旋转 |
| Motor | `AGITATOR_STOP` | 停止搅拌器 |
| Ventilation | `EXHAUST_ON` | 开启排风 |
| Ventilation | `EXHAUST_OFF` | 关闭排风 |
| Ventilation | `AIR_SUPPLY_ON` | 开启送风 |
| Ventilation | `AIR_SUPPLY_OFF` | 关闭送风 |
| Device | `REBOOT` | 重启设备 |
| Device | `SHUTDOWN` | 关闭设备 |
| Device | `FACTORY_RESET` | 恢复出厂设置 |
| Device | `TAKE_SNAPSHOT` | 拍照 |
| Device | `FORCE_SYNC` | 立即同步 |

### 5.8 OTA 参数

| 字段 | 示例 | 说明 |
|---|---|---|
| `version` | `2.1.0` | 目标版本 |
| `packageType` | `APP` | `APP` / `FIRMWARE` |
| `downloadUrl` | `https://...` | 安装包 URL |
| `sha256` | `ABC123...` | 包校验值 |
| `mandatory` | `false` | 是否强制更新 |
| `scheduledTime` | `2026-08-01T23:00:00Z` | 计划执行时间 |

[p.19]

### 5.9 Notification 参数与动作映射

| 字段 | 示例 | 说明 |
|---|---|---|
| `type` | `LICENSE_CHANGED` | 通知类型 |
| `priority` | `NORMAL` | `LOW` / `NORMAL` / `HIGH` |
| `title` | `License Updated` | 显示标题 |
| `message` | `New license is available` | 消息内容 |
| `action` | `SYNC` | 建议设备动作 |

通知动作：[p.20]

| 分类 | Type | Device Action |
|---|---|---|
| Synchronization | `SYNC_REQUIRED` | 调用 `/api/v1/device/sync` |
| Synchronization | `LICENSE_CHANGED` | 调用 `/api/v1/device/sync` |
| Synchronization | `CONFIG_CHANGED` | 调用 `/api/v1/device/sync` |
| Synchronization | `USERS_CHANGED` | 调用 `/api/v1/device/sync` |
| Synchronization | `STATUS_CHANGED` | 调用 `/api/v1/device/sync` |
| Synchronization | `ASSIGNMENT_CHANGED` | 调用 `/api/v1/device/sync` |
| OTA | `OTA_AVAILABLE` | 等待 OTA Topic |
| OTA | `OTA_CANCELLED` | 取消待执行升级 |
| Certificate | `CERTIFICATE_EXPIRING` | 查询证书状态 |
| Certificate | `CERTIFICATE_ROTATION_REQUIRED` | 调用证书轮换 API |
| Security | `SECURITY_POLICY_UPDATED` | 同步最新 Policy |
| Security | `DEVICE_SUSPENDED` | 进入 Suspended Mode |
| Security | `DEVICE_RETIRED` | 进入 Retired Mode |

### 5.10 Topic 数据留存

| Topic | RDS | S3 Archive |
|---|---|---|
| Heartbeat | 仅最新状态 | 否 |
| Telemetry | 聚合摘要 | 是 |
| ESG Report | 是 | 是 |
| Alarm | 是 | 是 |
| Event | 是 | 是 |
| ACK | 是 | 可选 |
| License | 是 | 可选 |
| Tamper | 是 | 是 |
| OTA | 是 | 可选 |

[p.21]

## 6. REST API 契约

### 6.1 API 总览

| 分类 | Method | Path | 认证 | 目的 |
|---|---|---|---|---|
| Onboarding | POST | `/api/v1/device/onboarding/request` | Onboarding Token | 提交 Onboarding 请求 |
| Onboarding | GET | `/api/v1/device/onboarding/status` | Onboarding Token | 查询审批状态，并在批准后领取初始配置与证书 |
| Certificate | POST | `/api/v1/device/certificate/rotate` | X.509 + mTLS | 获取替换证书 |
| Certificate | GET | `/api/v1/device/certificate/status` | X.509 + mTLS | 查询证书有效状态 |
| Synchronization | POST | `/api/v1/device/sync` | X.509 + mTLS | 从 CMP 同步设备状态 |
| Device Lifecycle | POST | `/api/v1/device/deactivate` | X.509 + mTLS | 确认设备停用 |

[p.22]

源稿未定义通用 HTTP Header、统一响应 Envelope、HTTP 状态码、业务错误码、超时、重试、幂等键、限流或版本协商。

### 6.2 POST `/api/v1/device/onboarding/request`

目的：发起 Onboarding。[p.23]

请求：

```json
{
  "serialNumber": "BNX202600001",
  "model": "BNX-100",
  "hardwareVersion": "1.0",
  "manufacturer": "Bio-Nexa",
  "manufactureDate": "2026-07-01"
}
```

| 参数 | 示例 | 说明 |
|---|---|---|
| `serialNumber` | `BNX202600001` | 库存校验使用的序列号 |
| `model` | `BNX-100` | 设备型号 |
| `hardwareVersion` | `1.0` | 硬件版本 |
| `manufacturer` | `Bio-Nexa` | 制造商 |
| `manufactureDate` | `2026-07-01` | 生产日期 |

响应：

```json
{
  "requestId": "REQ001",
  "status": "PENDING"
}
```

### 6.3 GET `/api/v1/device/onboarding/status`

目的：每 30 秒轮询审批状态，直至 `APPROVED` 或 `REJECTED`。[p.22-23]

响应分支：

```json
{ "status": "PENDING" }
```

```json
{
  "status": "REJECTED",
  "reason": "Serial Number Not Authorized"
}
```

```json
{
  "status": "APPROVED",
  "deviceId": "DEV001",
  "certificate": {
    "certificatePem": "...",
    "privateKey": "..."
  },
  "mqtt": {
    "endpoint": "xxxxx.iot.ap-southeast-1.amazonaws.com"
  },
  "configuration": {
    "heartbeatInterval": 60
  }
}
```

批准后的设备动作：安装证书 -> 连接 AWS IoT MQTT -> 发布 Heartbeat；AWS IoT 向 CMP 表明设备 Online，CMP 将设备标记为 `Onboarded`。[p.23]

### 6.4 POST `/api/v1/device/certificate/rotate`

目的：证书到期前领取新证书。[p.24]

请求：

```json
{
  "currentCertificateId": "CERT001"
}
```

响应：

```json
{
  "certificateId": "CERT002",
  "certificatePem": "...",
  "privateKey": "...",
  "effectiveDate": "2027-01-01",
  "expiryDate": "2028-01-01"
}
```

设备领取后将新证书存入 Keystore，使用新证书重新连接 AWS IoT，并发布 Heartbeat。

### 6.5 GET `/api/v1/device/certificate/status`

目的：查询证书状态；建议每日调用。[p.22, p.24]

```json
{
  "certificateId": "CERT002",
  "status": "ACTIVE",
  "expiryDate": "2028-01-01",
  "daysRemaining": 365
}
```

### 6.6 POST `/api/v1/device/sync`

目的：将 CMP 中以下域的最新状态作为单一事实源下发给设备：[p.25, p.27]

- Customer/Site Assignment 和 Authorization Window
- Device Metadata / Alias
- License Status、Validity、Entitlements
- Device Users
- Configuration
- Operational Status

请求：

```json
{
  "lastSyncTime": "2026-08-01T10:00:00Z"
}
```

源稿响应示例可还原为：

```json
{
  "assignment": {
    "customerId": "CUS001",
    "customerName": "ABC Hotel",
    "siteId": "SITE001",
    "siteName": "Hotel A Kitchen"
  },
  "device": {
    "alias": "Kitchen Processor 01"
  },
  "license": {
    "licenseId": "LIC001",
    "status": "ACTIVE",
    "validFrom": "2026-01-01",
    "validTo": "2027-12-31",
    "entitlements": [
      "REMOTE_CONTROL",
      "OTA",
      "ESG_REPORTING"
    ],
    "signature": "..."
  },
  "configuration": {
    "heartbeatInterval": 60,
    "telemetryInterval": 30,
    "cameraRefreshInterval": 1,
    "temperatureThreshold": 80
  },
  "deviceUsers": [
    {
      "userId": "USR001",
      "username": "operator01",
      "displayName": "Kitchen Operator",
      "passwordHash": "...",
      "status": "ACTIVE"
    }
  ]
}
```

响应域的完整字段定义、空值语义、增量同步语义、`lastSyncTime` 的处理方式和签名验证算法均未在源稿定义。

### 6.7 POST `/api/v1/device/deactivate`

目的：设备停用确认。[p.22]

源稿只给出 Method、Path、认证和目的，没有请求体、响应体、触发者、状态迁移或重试规则。

### 6.8 REST 调用频率与生命周期映射

| API | 建议频率 |
|---|---|
| `onboarding/request` | 一次 |
| `onboarding/status` | 每 30 秒，直至 Approved/Rejected |
| `sync` | 见下表 |
| `certificate/status` | 每日 |
| `certificate/rotate` | 收到指令或接近到期时 |

Sync 频率：[p.27]

| 设备状态/事件 | 频率 |
|---|---|
| Active | 每 5 分钟 |
| Suspended | 每 15 分钟 |
| Offline Recovery | 重连后立即 |
| MQTT Sync Notification | 立即 |

生命周期到通信动作的映射：[p.22]

| 状态 | 使用的接口/通道 | 目的 |
|---|---|---|
| Pending Onboarding | `onboarding/request` | 提交请求 |
| Pending Approval | `onboarding/status` | 轮询审批结果 |
| Approved | `onboarding/status` | 获取证书和初始配置 |
| Onboarded | MQTT Heartbeat | 首次心跳证明完成 Onboarding |
| Assigned | `sync` | 获取 Assignment |
| Licensed | `sync` | 获取 License |
| Active | `sync` + MQTT | 运行时操作 |
| Maintenance | `sync` | 获取运行策略 |
| Suspended | `sync` | 获取运行策略 |
| Certificate Renewal | `certificate/status` + `certificate/rotate` | 管理证书生命周期 |
| Retired | `sync` | 接收 Retired 状态 |

## 7. 业务流程归类

### 7.1 通用“通知后拉取”模式

```text
License/User/Configuration/Status Changed
  -> CMP 发布 MQTT Notification
  -> Device 收到通知
  -> Device POST /api/v1/device/sync
  -> Device 获取最新状态
  -> Device 更新本地缓存
```

[p.26]

### 7.2 13 个系统集成场景

#### 1. Device Onboarding

1. Device 提交 `POST onboarding/request`，CMP 返回 `PENDING`。
2. Admin 审核并批准。
3. Device 每 30 秒调用 `GET onboarding/status`。
4. CMP 返回 `APPROVED + Device ID + Certificate + MQTT Config`。
5. Device 安装证书、连接 AWS IoT MQTT 并发布 Heartbeat。
6. AWS IoT/CMP 确认设备 Online，CMP 将设备改为 `Onboarded`。[p.29]

#### 2. First Device Assignment

1. Admin 在 CMP 分配 Customer 与 Site。
2. CMP 发布 `SYNC_REQUIRED`。
3. Device 调用 `POST sync`。
4. CMP 返回 Assignment，Device 更新本地缓存。[p.29]

#### 3. License Creation & Distribution

1. Admin 创建 License；CMP 激活 License。
2. CMP 发布 `LICENSE_CHANGED`。
3. Device 调用 `POST sync` 获取 License 与 Entitlements。
4. Device 验签、缓存 License、启用已授权功能。[p.30]

#### 4. Device Periodic Synchronization

Device 定期调用 `POST sync`，获取 Assignment、License、Configuration、Device Users 和 Operational Status，并更新本地缓存。[p.30]

#### 5. Device User Synchronization

1. TenantAdmin 在 CMP 新增 Device User。
2. CMP 发布 `USERS_CHANGED`。
3. Device 调用 `POST sync` 获取 Device User List。
4. Device 更新本地用户数据库。[p.30]

#### 6. Configuration Change

1. Support 更新 Configuration。
2. CMP 发布 `CONFIG_CHANGED`。
3. Device 调用 `POST sync` 获取最新 Configuration。
4. Device 应用配置。[p.31]

#### 7. Operational Status Change

1. Admin 将状态改为 Maintenance。
2. CMP 发布 `STATUS_CHANGED`。
3. Device 调用 `POST sync`，获得 `Operational Status = Maintenance`。
4. Device 应用运行策略并进入 Maintenance Mode。[p.31]

#### 8. Device Suspension

1. Admin Suspend Device。
2. CMP 发布 `STATUS_CHANGED`。
3. Device 调用 `POST sync`，获得 `Status = Suspended`。
4. Device 禁止业务处理，但保留 Heartbeat 与 Telemetry。[p.31]

#### 9. License Renewal

1. Admin Renew License；CMP 更新有效期。
2. CMP 发布 `LICENSE_CHANGED`。
3. Device 调用 `POST sync` 获取更新后的 License。
4. Device 验签并更新本地 License 缓存。[p.31]

#### 10. Certificate Rotation

1. Device 调用 `GET certificate/status`，发现 `Expiring Soon`。
2. Device 调用 `POST certificate/rotate` 获取新证书。
3. Device 保存到 Keystore，使用新证书重连 AWS IoT，发布 Heartbeat。[p.32]

#### 11. Remote Command Execution

1. Customer 在 CMP 发起“Start Machine”。
2. CMP 将 Command 发布到 AWS IoT。
3. AWS IoT 向 Device 投递 `cmd`。
4. Device 执行命令并发送 ACK。
5. ACK 经 AWS IoT 回到 CMP，CMP 向 Customer 返回 `SUCCESS`。[p.32]

#### 12. OTA Upgrade

1. Support 在 CMP 创建 OTA Job。
2. CMP 向 AWS IoT 发布 OTA；AWS IoT 通知 Device。
3. Device 下载包、校验 SHA-256、安装并发送 ACK。
4. AWS IoT/CMP 将 Upgrade Result 返回给 Support。[p.32]

#### 13. Device Retirement

1. Admin Retire Device。
2. CMP 撤销 Assignment、License 和 Certificate。
3. CMP 发布 `STATUS_CHANGED`。
4. Device 调用 `POST sync`，获得 `Status = Retired`。
5. Device Disable Operations、Disable Login、Stop Services。[p.32]

### 7.3 Onboarding 详细正向流程

```text
Technical Support 扫描 QR Code
  -> 提取 Serial Number / Model / Hardware Version
  -> 提交 Onboarding Request
  -> CMP 校验 Device Inventory
  -> 检查 Serial Number 是否存在
  -> 检查是否已 Onboarded
  -> 创建 Pending Onboarding Request
  -> CMP Admin Review
  -> 若批准：生成 Device ID
  -> 生成 X.509 Certificate
  -> 生成 MQTT Configuration
  -> Device 轮询 Onboarding Status
  -> 返回 Device ID + Certificate + MQTT Endpoint
  -> Device 安装证书
  -> 连接 AWS IoT MQTT
  -> 发布首次 Heartbeat
  -> 标记 Device 为 Onboarded
```

[p.33-34]

### 7.4 Onboarding 异常流程

| 异常 | 判定与结果 |
|---|---|
| Serial Number Not Found | CMP 查询 Inventory 后拒绝：Unknown Serial Number |
| Device Already Onboarded | CMP 查询 Inventory 后拒绝：Device Already Onboarded / Duplicate Onboarding |
| Admin Rejects Request | Admin 拒绝；设备查询状态得到 `REJECTED` |
| Device Failed Certificate Installation | 设备得到 Approved/Certificate 但安装失败；继续轮询且从未连接 MQTT，最终触发 Onboarding Timeout |

[p.33]

## 8. 待确认事项与设计缺口

### 8.1 源稿内部不一致

1. **Tier 与 Payload 冲突**：p.8 定义 Tier 2 才使用 `meta + audit + data`，Tier 3 用于 Device Control；但 p.9 将 Telemetry、ESG Report、Tamper 标为 Tier 1 却又包含 `audit`，Command 也标为 Tier 1 而非 Tier 3。
2. **`seq` 必填规则与示例冲突**：p.8 写明 Tier 1/2 需要 `seq`，但 Command、OTA、Notification 等示例的 `meta` 仅有 `id` 与 `ts`。
3. **Heartbeat 字段模型不一致**：字段表使用 `networkType`、`cpuUsagePct`、`machineRunning` 等扁平名，JSON 示例使用 `network.type`、`system.cpuUsage`、`machine.running` 等嵌套名；`currentAmp` 与 `motorCurrentAmp` 也不一致。
4. **Heartbeat 表格错位**：`storageUsagePct` 行缺少 Type，导致 Required、Example、Purpose 列错位。
5. **状态集合不一致**：p.5 的运行状态只有 Active/Suspended/Retired，p.22、p.26、p.31 又使用 Maintenance；需明确 Maintenance 是正式状态、子状态还是 Policy Mode。
6. **Retired 定义缺口**：p.2 的 Device Lifecycle 状态定义表未列出 Retired，但迁移表和后续页面均使用 Retired。
7. **命名/拼写**：`DISCHARING` 疑似应为 `DISCHARGING`；`Restful` 更规范的写法为 REST API；Topic 路径使用小写，而部分时序图省略完整前缀。

### 8.2 API 契约缺口

- 未定义请求/响应字段的完整类型、必填性、长度、格式和枚举约束。
- 未定义 HTTP 状态码、统一错误体、稳定业务错误码、认证 Header 和证书身份映射。
- 未定义幂等、并发、超时、重试、限流和重复消息处理策略。
- `GET onboarding/status` 未说明如何定位请求（Token 隐式绑定、`requestId` Query，还是其他方式）。
- `POST sync` 未说明是全量还是增量、`lastSyncTime` 的语义、空域表达、版本号、ETag 和签名算法。
- `POST deactivate` 没有请求/响应模型和准确状态迁移。
- 未定义 Certificate Rotation 的双证书重叠期、失败回滚和旧证书撤销时点。

### 8.3 安全与隐私待确认

- Onboarding 和 Rotation 响应示例直接返回 `privateKey`；需要明确私钥生成位置、传输加密之外的包裹加密、一次性领取、存储、日志脱敏和销毁策略。
- Sync 响应示例下发 `passwordHash`；需要明确 KDF、Salt、版本、离线暴力破解防护及最小披露原则。
- Media 示例返回内部 `s3://` 路径，未定义设备上传授权、短期凭证、预签名 URL、对象权限和保留期。
- MQTT `audit.hash` 只描述为 SHA-256，没有明确规范化序列化、Hash 覆盖范围、签名主体、防重放和密钥管理。

### 8.4 数据与运行规则缺口

- Telemetry、ESG、Alarm 等字段没有单位规范、量程、精度、Null 语义、时区、采样时间和 Schema 版本。
- MQTT 没有明确 Retained Message、Last Will、Session、Keep Alive、最大 Payload、离线队列和 Topic ACL。
- QoS 2 Topic 的 Broker/客户端兼容性、重复投递处理和幂等键未定义。
- 留存策略只描述存储位置，未定义 RDS/S3 保存期限、分区、压缩、删除、Legal Hold 和数据地域。
- p.35-36 宣告了设备端数据库设计，但没有提供任何表、字段、索引、迁移或加密方案。

## 9. 建议的后续规范化产物

为把本设计转成可执行契约，建议按以下优先级补齐：

1. 冻结设备状态、商业状态、运行状态及 Maintenance 语义。
2. 冻结 MQTT Tier 与 Topic 矩阵，并为每个 Topic 建立版本化 JSON Schema。
3. 用 OpenAPI 定义 6 个 REST Endpoint 的请求、响应、认证、错误码和示例。
4. 建立 Notification、Command、Alarm、Event 的枚举目录和向后兼容规则。
5. 定义 `seq`、`meta.id`、Hash/Signature、ACK、超时和重放/幂等策略。
6. 单独完成私钥领取、设备用户验证材料和 Media 上传的安全设计。
7. 补充 Android Edge 本地数据库、Keystore、缓存更新和离线恢复设计。
