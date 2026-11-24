# CMP D/T11 上位机配置交付

R04、R19。设备群及单设备入口复用现有配置版本和发布流程。受控合约样例在本地用于校验候选 Schema、旧客户端和回执，实际设备验证为 `NOT_RUN`。候选 Schema 单独列为联调材料，现行 Device Sync 契约和兼容基线保持原形。示例客户端版本 `t11-host-fixture.1` 仅用于本地夹具。

## 原型、设置和业务上下文

对照 [原型配置表单与 collectConfigData](../index19.html)、[DEC-018@1.0.0](../../contracts/decisions/changes/DEC-018-freeze-1.0.0.md)、[冻结字段策略](../../contracts/configuration/configuration-v1-policy.json) 和 [Sync OpenAPI](../../contracts/rest/device-sync-api.json)。原型的输入初值用于演示。候选交付版本 1 的 `settings` 与现有 `configuration` 使用同一份完整快照。

| 原型字段或概念 | Sync 路径 | 单位 | 默认及范围 | 必填、版本或证据 |
| --- | --- | --- | --- | --- |
| 原型无心跳字段 | `configuration.heartbeatInterval` / `configurationDelivery.settings.heartbeatInterval` | 秒 | 60，10～900 | 整数，已有协议和候选 1 必填 |
| 原型无遥测字段 | `configuration.telemetryInterval` / `configurationDelivery.settings.telemetryInterval` | 秒 | 30，5～3600 | 整数，已有协议和候选 1 必填 |
| 图像上传间隔有不同用途 | `configuration.cameraRefreshInterval` / `configurationDelivery.settings.cameraRefreshInterval` | 分钟 | 1，1～1440 | 整数，已有协议和候选 1 必填 |
| 加热上下限与告警温度阈值各有独立含义 | `configuration.temperatureThreshold` / `configurationDelivery.settings.temperatureThreshold` | °C | 80，0～120 | 数值，已有协议和候选 1 必填 |
| `contract.contract_name` | `configurationDelivery.context.contract.name`，同对象提供 `contractNumber` | 文本 | 无适用合约时为 `null` | 候选 1 上下文字段必填，取本设备当前有效关联的同客户合约 |
| `contract.region` / `contract.sub-region` | `assignment.region` / `assignment.subregion`，候选 `context.region` / `context.subregion` | 文本 | 无对应属性时为 `null` | 取设备所属客户的当前站点 |
| `contract.site` | `assignment.siteName` / `configurationDelivery.context.site` | 文本 | 候选上下文无站点时为 `null` | 站点名称，使用设备的 `siteId` 关联 |
| `alias.alias_setting` | `device.alias` / `configurationDelivery.context.alias` | 文本 | 无别名时为 `null` | 取设备实体 |
| `image.default_resolution.width` / `height` | 待设备方签认 | px | 原型 1024 / 768 | DEC-018 及候选 1 均不支持 |
| `image.default_upload_interval` | 待设备方签认 | 秒 | 原型 0.5 | DEC-018 及候选 1 均不支持 |
| `operation.rotation_interval_M` / `rotation_duration_N` | 待设备方签认 | 秒 | 原型 15.0 / 2.0 | DEC-018 及候选 1 均不支持 |
| `configuration.mixer_motor_overload_current` | 待设备方签认 | A | 原型 5.0 | DEC-018 及候选 1 均不支持 |
| `configuration.min_heating_temperature` / `max_heating_temperature` | 待设备方签认 | °C | 原型 5.0 / 75.0 | DEC-018 及候选 1 均不支持 |
| `language.available` | 待设备方签认 | 字符串数组 | 原型选中 Simplified Chinese | DEC-018 及候选 1 均不支持 |
| `network.cloud_platform_domain` / `time_server` | 待设备方签认 | 主机名 | 原型演示域名 / `asia.pool.ntp.org` | DEC-018 及候选 1 均不支持 |

默认值仅用于新建草稿表单。保存版本时必须提交全部四个设置字段，未知字段、缺项、越界和整数单位的小数会被拒绝。站点、合约和别名上下文由服务端读取。

## 候选交付和回执

设备沿用 mTLS `POST /api/v1/device/sync`。发布复用 `CONFIG_CHANGED` 通知并提示设备 Sync，周期 Sync 可补拉。云端优先解析已生效的设备定向配置，再解析型号配置。每次单独按证书设备 ID 和生效时间求值。同型号的设备可能取得不同版本。

未设置 `DEVICE_CONFIGURATION_DELIVERY_TARGETS` 时，设备 API 仅返回现有快照。候选设备须同时匹配该配置中精确的设备 ID、审核后的上位机构建标识和请求中 `configurationProtocol.schemaVersion: 1`。配置格式为以设备 ID 为键、上位机构建标识为值的 JSON 对象，空对象或无效配置关闭整批候选。未协商、未匹配、未知协议版本或没有生效版本时，响应省略 `configurationDelivery`；`configuration` 的形状保持原状。

本地样例请求使用 `{"configurationProtocol":{"schemaVersion":1,"clientVersion":"t11-host-fixture.1"}}`。测试合约 `T11-SAMPLE-01` 关联样例设备，站点为「T11 门店」，区域为「华东」，子区域为「T12」，设备别名为「T11-门店设备」。候选响应的 `settings` 为 `{"heartbeatInterval":60,"telemetryInterval":30,"cameraRefreshInterval":1,"temperatureThreshold":72.5}`，上下文和接收及应用回执均由本地夹具校验。

| 状态 | 记录依据 |
| --- | --- |
| 通知 | 对应发布版本的 `CONFIG_CHANGED` Outbox 状态。设备可在无通知记录时通过 Sync 补拉。 |
| 待确认 | 云端生成该设备的版本快照并登记 `deliveryId`。 |
| 已交付 | 设备校验收到内容后，在后续 Sync 回传该快照的 `deliveryId`、`configurationId`、`version` 及 `RECEIVED`。 |
| 已应用 | 设备实际应用成功后回传相同标识及 `APPLIED`。该状态涵盖已交付。 |

回执随相同的 `configurationProtocol` 发出，允许重复提交。格式无效返回 400；已启用设备回传一个不存在或与自身及版本不匹配的历史快照返回 409，可丢弃无效回执后重新 Sync。迟到的回执仅记在原快照，不能证明后续版本或更新后的上下文已应用。MQTT 发布、生成 HTTP 响应和 `lastSyncTime` 都不会推进配置回执状态。回退为旧协议时忽略格式合法的候选回执。

## 联调、启用和回退条件

目标环境联调状态为 `NOT_RUN`。启用需先取得设备方提供的确切上位机构建及样件，双方确认 [候选快照和回执 Schema](../../contracts/configuration/device-sync-configuration-delivery-candidate.openapi.json)，并在带当前合约与站点关系的受控设备上验收四项值应用、回执组合、离线补拉、目标隔离、旧客户端和回退。使用测试环境的设备证书和受控合约样本，记录确切构建、设备 ID、收到的配置版本和应用读回。未取得该证据时名单保持为空。

迁移与支持回执读取的服务端构建先在相应环境生效，再经批准添加已验证设备和上位机构建的精确组合。回退传输协议时从名单移除目标并确认旧 `configuration` 仍可读取。回退设置时从历史版本创建新草稿，核对目标和生效时间后发布；后续 Sync 拉取新版本号。既有发布版本和回执可用于核对历史。
