# FE-05 Customer 与 Site 页面

实现：[apps/admin-web/src/pages/customers](../../apps/admin-web/src/pages/customers/CustomersPage.tsx)、[apps/admin-web/src/pages/sites](../../apps/admin-web/src/pages/sites/SitesPage.tsx)；测试：[customers.test.tsx](../../apps/admin-web/test/customers.test.tsx)、[sites.test.tsx](../../apps/admin-web/test/sites.test.tsx)。

## 交付状态（分层）

| 层级 | 状态 | 当前证据与边界 |
|---|---|---|
| module implemented | PASS | Customer/Site CRUD、校验、权限、冲突与双向游标组件测试通过 |
| app integrated | PASS | `/customers`、`/sites` 已接入 BrowserRouter、共享 API client、会话权限和 Toast |
| browser verified | PASS | Chromium 覆盖 CRUD、非法时区、关联停用、409、窄屏表格和 Modal 键盘边界 |
| target integrated | NOT RUN / NO RECEIPT | 未取得目标 Admin API 的真实数据、权限和并发联调凭据 |

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-05（P1 / 管理后台前端），依赖 FE-02、BE-CUS-01、BE-CUS-02（均已交付） |
| 数据事实源 | BE-CUS-01 `admin-customer-api.json`（customer:read/write）；BE-CUS-02 `admin-site-api.json`（site:read/write，DEC-011） |
| 路由 | `/customers`（平台三角色）、`/sites`（五角色；Customer scope 服务端强制）——CT-06 矩阵外扩展，已在契约测试显式登记，防止路由表无约束膨胀 |
| 功能边界 | 无地图/地理编码；软删除 UI 未纳入（任务核心内容为创建/编辑/停用；deleteCustomer/deleteSite 已有后端契约，前端入口待产品确认后追加） |

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `CustomersPage` | 状态筛选（全部/正常/已停用）+ 游标列表（名称/状态/创建/更新时间）+ 详情面板 + 新建/改名（Modal 表单）+ 停用（原因必填） |
| `SitesPage` | 四维筛选（所属客户/设备区域/子区域/状态）+ 游标列表（名称/客户/区域/子区域/时区/联系人/设备数/状态）+ 详情面板（含设备数）+ 新建/编辑（customerId 创建后不可变，编辑时只读）+ 停用（弹窗展示关联设备数提示 + 原因必填） |
| `sites-state.ts` | `isValidTimeZone`（Intl 运行时校验 IANA 标识）+ `validateSiteInput`（名称必填≤200、时区、邮箱格式） |
| `components/Modal.tsx` | Portal 表单模态框：初始焦点、Tab 双向循环、Esc、焦点回收和背景 inert |
| `ScopeFilter` 扩展 | 可选 Device 层级（Region→Subregion→Site→Device 四级联动，上游变更清空下游），供后续设备页复用 |
| `customers-api.ts` / `sites-api.ts` | 契约装配：列表筛选 + 游标、创建、PATCH（If-Match）、停用（If-Match + reason） |

## 3. 验收基准与证据（vitest + jsdom）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| CRUD E2E | Playwright 真实 Chromium 覆盖 Customer/Site 创建、编辑、停用；If-Match 由 API client 装配 | ✅（本地浏览器） |
| 非法时区 | `Mars/Olympus` 客户端拦截不提交 + 内联错误；`Asia/Shanghai` 通过；纯逻辑 `isValidTimeZone` 用例 | ✅ |
| 有关联对象停用提示 | 停用弹窗展示“该站点当前关联设备 N 台” | ✅ |
| 并发冲突 | 409 VERSION_CONFLICT → “数据已被他人修改” + 刷新；409 CONFLICT（重复停用）→ 展示后端 message | ✅ |
| 按角色隐藏写操作 + 后端 403 | canWrite=false 时无新建/编辑/停用按钮；列表 403 → 无权提示 | ✅ |
| 键盘/焦点/标签 | Modal 初始焦点、Tab 循环、背景 inert、Esc 和焦点回收；字段均由 htmlFor 关联 | ✅ |

当前证据命令：`pnpm vitest run apps/admin-web/test/customers.test.tsx apps/admin-web/test/sites.test.tsx`、`pnpm check:admin-web-e2e`、`pnpm verify`。HTTP mock 与目标环境联调分层记录。

## 4. 对接说明

- **FE-06+**：四级联动直接复用 `ScopeFilter`（传 `devices` 即启用 Device 层）；
- 写操作权限：`canWrite` 由集成层按会话角色（PlatformSuperAdmin/PlatformOperator）注入；后端 AUTH-01 仍强制授权；
- 路由 `/customers`、`/sites` 已注册（平台管理分组），面包屑自动生成。

## 5. 未决风险

- Customer 详情仅有 name/status 字段（契约范围），“设备数”等聚合指标无 API 来源未展示；
- Site 筛选的 region/subregion 为自由文本输入（契约无字典枚举接口）；若后续提供字典 API 可升级为下拉；
- 软删除入口未提供前端 UI（契约已备），待产品决策。
