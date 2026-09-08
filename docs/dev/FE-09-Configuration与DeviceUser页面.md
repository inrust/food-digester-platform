# FE-09 Configuration 与 Device User 页面

实现：[configuration](../../apps/admin-web/src/pages/configuration/ConfigurationsPage.tsx)、[device-users](../../apps/admin-web/src/pages/device-users/DeviceUsersPage.tsx)；测试：[configuration.test.tsx](../../apps/admin-web/test/configuration.test.tsx)、[device-users.test.tsx](../../apps/admin-web/test/device-users.test.tsx)。

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
| 详情 | 分配历史（ACTIVE/REVOKED + 时间）；同步版本；修改资料（原因必填，空显示名=null） |
| 密码重置 | type=password + 必填原因；提交后表单关闭不回显；提示"设备下次同步领取新验证材料" |
| 停用 | 强制原因 + If-Match=version；确认文案明示"停用用户不进入新 Sync"；停用后停用/分配按钮禁用 |
| 分配/撤销 | 批量勾选 + 强制原因 + If-Match；撤销仅列 ACTIVE 分配；全成或全败由后端保证 |

所有写操作成功后经 onRefresh 回源；409 VERSION_CONFLICT 经 ErrorNotice 提示刷新。

## 3. 验收基准与证据（vitest + jsdom，19 例 + parity 2 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 只渲染 V1 四字段且单位正确 | 表单字段集合/默认值/单位文案（秒/秒/分钟/°C）断言；parity：CONFIG_V1_FIELDS 与冻结策略 JSON 的键/单位/范围/默认值/整数约束逐项一致 | ✅ |
| 发布后版本只读 | PUBLISHED 卡片无 input、发布禁用（title 提示）；DRAFT 可发布；历史 payload 完整只读展示 | ✅ |
| 非法范围有字段错误 | 越界/非整数/空值的字段级错误文案 + 提交禁用；温度阈值允许小数但越界报错 | ✅ |
| 候选扩展字段不存在 | DOM 全文负向断言（图像/上传间隔/旋转/电机/过载/加热/语言/云域名/NTP/温度上下限/cloudDomain/ntpServer 等） | ✅ |
| 敏感字段浏览器快照为 0 | document.body 无 passwordHash；密码值提交后不出现在 DOM（textContent 与 innerHTML 双向断言）；type=password + autocomplete=new-password | ✅ |
| 密码只进入一次受控提交 | 创建/重置提交后表单关闭不回显；API 装配测试：password 仅在 create/update 请求体，disable 请求体不含密码 | ✅ |
| 派生字段只读 | derivedContext 渲染无输入控件 | ✅ |
| If-Match/强制原因 | update/disable/assign/revoke 均 ifMatch=version + reason；UI 层原因必填 | ✅ |
| CT-06 锚点 | 配置 3 元素 + 设备用户 4 元素双向锁定 | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。

## 4. 未决风险

- 设备用户"同步状态"仅有同步版本号（version）可展示；USERS_CHANGED 投递状态无查询接口（与配置投递状态不同），如需逐设备投递可见性需后端扩展；
- Operator 无 device-user:read（AUTH-01 矩阵），设备用户页面对其不可见——与权限矩阵一致，非缺陷；
- 配置 effectiveAt 仅做格式校验，时序合法性（早于当前时间等）由服务端裁决。
