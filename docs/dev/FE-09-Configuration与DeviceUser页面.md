# FE-09 Configuration 与 Device User 页面

实现：[configuration](../../apps/admin-web/src/pages/configuration/ConfigurationsPage.tsx)、[device-users](../../apps/admin-web/src/pages/device-users/DeviceUsersPage.tsx)；测试：[configuration.test.tsx](../../apps/admin-web/test/configuration.test.tsx)、[device-users.test.tsx](../../apps/admin-web/test/device-users.test.tsx)。

## 0. 交付状态

**DEC-018 / FE-09 仓库内 Gate：CLOSED（2026-09-14）**。Configuration 与 Device User 已完成组合根接入；原型 M/N 更新入口已按 DEC-018 改为 Reject。目标环境验收仍是独立发布 Gate，不纳入本结论。

| 层级 | 当前状态 | 可复核证据 |
|---|---|---|
| module present | **PASS** | Configuration 与 Device User 页面、controller、API 和同步状态模块存在；`pnpm --filter @fdp/admin-web typecheck` |
| app integrated | **PASS** | 两路由和正式 operations 已进入组合根/交付清单；`pnpm check:admin-web-delivery` |
| browser verified | **PASS（本地）** | Chromium 覆盖两路由、角色与失败关闭；`pnpm check:admin-web-e2e` |
| target integrated | **NOT RUN / NO RECEIPT** | 尚无当前提交对应的 Cognito、部署后配置/用户 API、设备 Sync 回执；`pnpm check:admin-web-target-evidence` 当前应失败关闭 |

整改依据：[FE-06至FE-10 全面复盘检查报告](../audit/FE-06至FE-10全面复盘检查报告-2026-09-10.md)；目标回执规则：[FE-06～FE-10 目标环境验收证据采集说明](../audit/evidence/FE-06至FE-10-目标环境验收证据采集说明.md)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-09（P1），依赖 FE-02（已交付）、BE-CFG-01（admin-configuration-api.json）、BE-DUSR-01/02（admin-device-user-api.json） |
| 路由 | `/configurations`（配置管理，config:read = 平台三角色）、`/device-users`（设备用户，device-user:read = SuperAdmin/Auditor/CustomerAdmin；Operator 无此权限点） |
| DEC-018@1.0.0 | V1 配置仅四字段：heartbeatInterval（秒 10~900 默认 60）、telemetryInterval（秒 5~3600 默认 30）、cameraRefreshInterval（**分钟** 1~1440 默认 1）、temperatureThreshold（°C 0~120 默认 80）；常量与冻结策略 JSON 由 parity 测试双向锁定 |
| 候选扩展 | 图像/上传间隔、旋转、电机过载、温度上下限、语言、云域名/NTP 不进入 V1：不渲染任何字段（DOM 负向断言锁定） |
| DEC-004 | 设备本地密码仅写接口受控接收一次（writeOnly），不回显/不持久化；类型层无密码字段；任何 DOM 不出现 passwordHash |

### CT-06 挂载说明

- 配置元素（device-manage.button.viewConfig/updateConfig/confirm，源 BE-CFG-01）由 `/configurations` 页承载，锚点 `config-detail`/`config-version-create`/`config-publish`；
- 设备用户元素（settings 页 addDeviceUser/deviceUserFilter/resetDeviceUserPassword/deleteDeviceUser，源 BE-DUSR-01/02）由 `/device-users` 页承载；FE-16 交付设置页时可直接嵌入 `DeviceUsersPage`；
- 锚点映射由 contract-parity 测试锁定（元素 ⇄ testid 双向）。

## 2. 交付物

### Configuration（/configurations）

| 模块 | 内容 |
|---|---|
| 列表 | targetModel/targetDeviceId 筛选；名称/目标/版本数/最新已发布/创建人 |
| 详情 | 版本历史（不可变：payload 四字段只读展示含单位，无编辑入口）；派生上下文（Alias/Site/Region/Subregion/Contract 只读，不随配置提交） |
| 新建配置 | 名称 + 目标二选一（型号/设备）+ 可选原因 |
| 新建版本 | 四字段表单（默认值预填、前端范围/整数预校验、字段级错误）；changeNote/reason；仅提交四字段快照 |
| 发布 | 仅 DRAFT 可发布（已发布版本按钮禁用并提示"历史版本不可覆盖"）；可选 effectiveAt（RFC 3339 校验）+ reason；成功后提示 CONFIG_CHANGED |
| 同步状态 | PUBLISHED 版本可查每目标设备投递状态（PENDING/PUBLISHED/FAILED） |

### Device User（/device-users）

| 模块 | 内容 |
|---|---|
| 列表 | customer/status/keyword 筛选（Customer 角色隐藏客户选择，fixedCustomerId 强制）；同步版本 v{n} 列；ACTIVE 分配设备数 |
| 创建 | 用户名（同客户唯一）+ 显示名 + 设备本地密码（type=password，一次受控提交）+ 可选原因 |
| 详情 | 分配历史；实体版本；逐设备 USERS_CHANGED 状态；进入 Sync 快照的版本/提供时间/后续 lastSyncTime 确认；设备本地应用保持 `NOT_REPORTED` |
| 密码重置 | type=password + 必填原因；提交后表单关闭不回显；提示"设备下次同步领取新验证材料" |
| 停用 | 强制原因 + If-Match=version；确认文案明示"停用用户不进入新 Sync"；停用后停用/分配按钮禁用 |
| 分配/撤销 | 批量勾选 + 强制原因 + If-Match；撤销仅列 ACTIVE 分配；全成或全败由后端保证 |

所有写操作成功后经 onRefresh 回源；409 VERSION_CONFLICT 经 ErrorNotice 提示刷新。

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| V1 四字段与只读历史 | 单位、范围、默认值和发布后不可变与冻结策略一致 | **LOCAL PASS** |
| 非法/扩展字段失败关闭 | 字段级错误且候选扩展字段不进入 DOM | **LOCAL PASS** |
| 敏感字段零回显 | 密码仅写一次；DOM/DTO 无 passwordHash | **LOCAL PASS** |
| If-Match 与强制原因 | 用户更新、停用、分配、撤销均受版本和原因约束 | **LOCAL PASS** |
| 同步阶段分离 | 实体版本、Outbox、快照版本、后续确认和本地应用未知分别展示 | **LOCAL PASS** |
| CT-06 锚点 | 配置和设备用户元素双向锁定 | **LOCAL PASS** |

仓库内证据命令：`pnpm exec vitest run apps/admin-web/test/configuration.test.tsx apps/admin-web/test/device-users.test.tsx apps/cloud-api/test/admin-device-user.test.ts apps/cloud-api/test/device-sync.test.ts`、`pnpm check:admin-web-delivery`、`pnpm check:admin-web-e2e`、`pnpm verify`。

## 4. 可追踪问题

| ID | 状态 | Owner | 关闭条件 | 验证命令 |
|---|---|---|---|---|
| FE09-PROTO-01 | **OPEN / PROTOCOL GAP** | Device protocol owner | 若产品要求证明设备本地已应用 Device User，冻结带版本的应用 ACK 协议、持久化回执并更新页面；当前必须显示 `NOT_REPORTED` | `rg -n "deviceApplyStatus|NOT_REPORTED" apps/cloud-api apps/admin-web contracts/rest/admin-device-user-api.json` |
| FE09-TARGET-01 | **NOT RUN / NO RECEIPT** | Release QA | 隔离环境证明配置发布、USERS_CHANGED、设备 Sync 确认、并发冲突和敏感字段零泄露，绑定精确 HEAD 并清理 | `pnpm check:admin-web-target-evidence` |

Operator 不具备 `device-user:read`、配置时序由服务端裁决均是正式权限/校验边界，不作为未决缺陷。

仓库内 Gate 收敛证据：[DEC-018 / FE-09 Gate 收敛记录](../audit/DEC-018-FE-09-Gate收敛记录-2026-09-14.md)。
