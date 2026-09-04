# DEC-018 Configuration V1 实施记录

## 冻结结论

DEC-018@1.0.0 将 V1 Configuration 固定为四字段完整快照：

| 字段 | 类型 | 单位 | 范围 | 默认值 |
|---|---|---|---|---|
| `heartbeatInterval` | integer | 秒 | 10～900 | 60 |
| `telemetryInterval` | integer | 秒 | 5～3600 | 30 |
| `cameraRefreshInterval` | integer | 分钟 | 1～1440 | 1 |
| `temperatureThreshold` | number | °C | 0～120 | 80 |

图像、旋转、电机、温度上下限、语言、云平台域名和 NTP 均不属于 V1。提交缺失字段、候选扩展或未知字段时失败关闭，不做静默裁剪、单位换算或隐式扩展。

## 实施闭环

- 单一策略源：`contracts/configuration/configuration-v1-policy.json`，由 JSON Schema 锁定冻结值，并提供 TypeScript 常量；
- 领域校验：`packages/domain/src/configuration.ts` 从统一策略派生范围，创建版本时强制四字段完整快照；
- 管理 API：`contracts/rest/admin-configuration-api.json` 与 `apps/cloud-api/src/admin/configuration` 实现不可变版本、发布历史、同步状态和字段级失败；
- 设备 Sync：`contracts/rest/device-sync-api.json` 与 `apps/cloud-api/src/device/sync.ts` 只下发最新有效的 V1 四字段完整快照；
- 跨层一致性：契约测试逐字段比对统一策略、Admin OpenAPI 和 Sync OpenAPI，防止单位、范围或默认值漂移。

## Gate 状态

- CT-03、BE-CFG-01、BE-SYNC-01、QA-02 的 DEC-018 契约与后端实施已闭环；
- FE-09 尚未实施，因为 FE-02 前端基座尚未交付。该状态不影响 DEC-018 冻结值生效，但管理页面 Gate 仍保持未完成；后续页面只能消费统一策略中的四字段。

## 验证结果

- DEC-018 聚焦测试：领域、管理 API 与 Device Sync 共 29/29 通过；
- 全仓 `pnpm verify`：实现测试 683/683、契约测试 254/254、脚本测试 53/53，类型检查 19/19、构建 13/13；Schema、迁移、模块边界和敏感信息门禁全部通过（2026-09-04）。

## 剩余边界

- 默认值是协议与界面初始化基线；已发布版本仍要求提交四字段完整快照，不在服务端静默补字段；
- 新字段只能通过新协议版本和设备能力协商引入，不得直接放宽 V1；
- 配置发布后的设备确认状态仍依赖后续回执能力，当前状态视图只反映 `CONFIG_CHANGED` Outbox 投递状态。
