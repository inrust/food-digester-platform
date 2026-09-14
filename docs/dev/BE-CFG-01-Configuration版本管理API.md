# BE-CFG-01 Configuration 版本管理 API

实现：[apps/cloud-api/src/admin/configuration](../../apps/cloud-api/src/admin/configuration/index.ts)；领域规则：[packages/domain/src/configuration.ts](../../packages/domain/src/configuration.ts)；统一策略：[configuration-v1-policy.json](../../contracts/configuration/configuration-v1-policy.json)；OpenAPI：[admin-configuration-api.json](../../contracts/rest/admin-configuration-api.json)；验收测试：[admin-configuration.test.ts](../../apps/cloud-api/test/admin-configuration.test.ts)（PGlite 真实 PostgreSQL）+ 领域单测 [configuration.test.ts](../../packages/domain/test/configuration.test.ts)。

> 证据治理：当前本地全仓证据命令为 `pnpm verify`；精确快照与整改闭环见 [全面复盘检查报告](../audit/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md)。目标 AWS 验收必须按 [证据采集说明](../audit/evidence/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md) 生成与待发布提交绑定的回执，并通过 `pnpm check:aws-admin-business-evidence`；缺失回执不得以本地测试替代。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CFG-01（P1 / 管理后台后端），依赖 AUTH-01、DB-02、DOM-03、DEC-018（均已交付） |
| 配置内容 | DEC-018@1.0.0 冻结的 `heartbeatInterval`、`telemetryInterval`、`cameraRefreshInterval`、`temperatureThreshold` 四字段完整快照 |
| 允许范围 | Heartbeat 10～900 秒（默认 60）；Telemetry 5～3600 秒（默认 30）；Camera Refresh 1～1440 分钟（默认 1）；温度阈值 0～120 °C（默认 80） |
| 派生字段 | Contract/Region/Subregion/Site/Alias 从业务实体读取（`derivedContext`，配置页只读展示）；随配置提交即 400 |
| V1 排除字段 | 图像、旋转、电机、温度上下限、语言、云平台域名和 NTP 不属于 V1，提交即 400；未知字段同样失败关闭 |
| 不可变性 | 版本仅 create（DRAFT）与 publish（DRAFT→PUBLISHED 条件更新）两条写路径；payload 无更新入口，历史版本不可覆盖，旧版本始终可审计读取 |
| 功能边界 | 不实现设备端应用配置；BE-SYNC-01 已消费 `resolveEffectiveConfiguration` 下发最新有效完整快照；FE-09 页面已由 FE-02 基座接入 |

## 2. 端点与 Schema

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/configurations` | `config:publish` | 创建配置：targetModel / targetDeviceId 二选一（服务校验 + DB CHECK `device_configurations_exactly_one_target` 兜底）；目标设备须存在且未退役；201 |
| `GET /api/v1/admin/configurations` | `config:read` | 列表（targetModel/targetDeviceId 过滤），含 versionCount/latestPublishedVersion |
| `GET /api/v1/admin/configurations/{id}` | `config:read` | 详情：全部版本 + `derivedContext`（仅按设备发布：Alias/Site/Region/Subregion/当前有效 Contract） |
| `POST .../versions` | `config:publish` | 创建 DRAFT 版本：统一策略约束四字段完整快照，越界、缺失、候选扩展或未知字段 → 400；版本号 = max+1（并发 P2002 → 409）；201 |
| `POST .../versions/{version}/publish` | `config:publish` | DRAFT→PUBLISHED 条件更新（重复/并发 → 409）；effectiveAt 缺省为发布时间；每个非 Retired 目标设备一条 CONFIG_CHANGED Outbox（`bnx/device/{id}/notification`，data `{type, action:'SYNC'}`，aggregateId=versionId） |
| `GET .../versions/{version}` | `config:read` | 版本详情（旧版本审计读取） |
| `GET .../versions/{version}/status` | `config:read` | 同步状态：每目标设备的通知投递状态（Outbox PENDING/PUBLISHED/FAILED；设备确认回执由 BE-SYNC-01 补齐） |

**审计**：`configuration.create` / `configuration.create_version` / `configuration.publish` 各一次（DOM-03 audited，SUCCESS 与业务同事务）。

**Sync 读取路径**（BE-SYNC-01 消费）：`resolveEffectiveConfiguration(deviceId, at)` —— 设备定向优先，否则型号定向；已发布且 `effectiveAt <= at` 的最高版本（领域 `selectEffectiveVersion`）；无配置 → null，设备不存在 → 404。

## 3. 数据模型变更

- `device_configurations` 增加 `target_device_id`（migration `20260829090000_configuration_target_device`）+ 二选一 CHECK + 索引；`ConfigurationVersion` 沿用既有模型（payload JSON 完整快照、@@unique(configurationId, version)）。

## 4. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 四字段范围、单位、默认值一致 | 统一策略、领域常量、Admin OpenAPI、Sync OpenAPI 逐字段一致性测试 | ✅ |
| 候选扩展和未知字段均拒绝 | 图像、旋转、电机、温度上下限、语言、网络和未知字段全部 400 VALIDATION_FAILED，版本数恒 0 | ✅ |
| 派生字段不能随配置提交修改 | contract/region/subregion/site/alias 提交 → 400（derived/read-only）；详情 derivedContext 从业务实体读取验证 | ✅ |
| V1 排除网络字段提交失败 | cloudDomain/ntpServer 提交 → 400（excluded from V1） | ✅ |
| 历史版本不可覆盖；旧版本仍可审计读取 | 重复发布 409；publish 为 DRAFT 条件更新（无 payload 更新路径）；v2 发布后 v1 原样可读 | ✅ |
| 发布生成 CONFIG_CHANGED | 型号配置：2 台同型号各一条 Outbox（其他型号不通知、Retired 不通知）；审计恰好一次 | ✅ |
| 发布后 Sync 返回最新有效版本 | resolveEffectiveConfiguration：型号 v1 → v2 未来生效仍返回 v1 → 到点返回 v2；设备定向优先；无配置 null | ✅ |
| 按设备/型号发布并查询同步状态 | 二选一校验（都给/都不给 400；不存在 404；Retired 409）；status 端点返回每设备投递状态 | ✅ |
| 附加 | 版本号递增；权限矩阵（Auditor 读放行写 403、Customer 403、未认证 401）；错误码对齐 CT-05；DTO 与契约封闭一致；无 AWS 依赖 | ✅ |

DEC-018 聚焦测试 29/29 通过；全仓 `pnpm verify` 退出 0：实现测试 683/683、契约测试 254/254、脚本测试 53/53，类型检查 19/19、构建 13/13（2026-09-04）。

## 5. 未决风险

- 同步状态当前仅覆盖通知投递（Outbox）；设备确认回执依赖 BE-SYNC-01 的 lastSyncTime/版本号机制；
- 同一设备允许存在多个设备定向配置，Sync 解析取最近生效者；如需唯一可在后续加部分唯一索引；
- Contract 派生取"当前时间窗内最新合同"（BE-CON-01/02 未实现，状态机对齐后可能需调整选择规则）；
- CONFIG_CHANGED 实际 MQTT 投递依赖下行分发器（Outbox 当前仅归档链路）。
- FE-09 已实施并完成仓库内 Gate：页面只渲染统一策略四字段；被 DEC-018 排除的原型候选字段不得恢复。目标环境验收仍以精确提交绑定回执为准。
