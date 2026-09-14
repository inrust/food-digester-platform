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
- 管理前端：`/configurations` 只渲染四字段，提供不可变版本历史、发布与同步状态；`/device-users` 完成受控密码、分配与同步状态流程；
- 跨层一致性：契约测试逐字段比对统一策略、Admin OpenAPI 和 Sync OpenAPI，防止单位、范围或默认值漂移。

## Gate 状态

- **CLOSED（2026-09-14）**：CT-03、BE-CFG-01、BE-SYNC-01、FE-09、QA-02 已全部闭环；
- FE-09 已接入正式组合根与交付清单，Configuration 页面只消费统一策略四字段，发布版本只读；Device User 页面不显示 `passwordHash`，密码提交后不回显；
- Device Operate 原型的 M/N 更新入口已按 DEC-018 改为 Reject，仅保留温度阈值跳转 Configuration，防止候选扩展从旁路重新进入 V1。

## 验证结果

- FE-09 聚焦测试覆盖四字段/单位/范围/默认值、发布后只读、候选扩展字段缺席、设备用户受控密码与敏感字段 DOM 零回显；
- 当前仓库验证结果以本次提交前执行的 `pnpm verify` 输出为准；目标环境仍须使用与精确提交绑定的验收回执，不以本地 Gate 替代。

## 剩余边界

- 默认值是协议与界面初始化基线；已发布版本仍要求提交四字段完整快照，不在服务端静默补字段；
- 新字段只能通过新协议版本和设备能力协商引入，不得直接放宽 V1；
- 配置发布后的设备确认状态仍依赖后续回执能力，当前状态视图只反映 `CONFIG_CHANGED` Outbox 投递状态。
