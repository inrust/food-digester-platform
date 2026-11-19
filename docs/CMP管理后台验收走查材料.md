# CMP 管理后台候选版本验收与项目方走查

2026-11-19 · 工作包 E / T12

| 项目 | 当前结论 |
| --- | --- |
| 验收候选 | [`353d2deb643b5068450ec77c4626d9289df97514`](https://github.com/inrust/food-digester-platform/commit/353d2deb643b5068450ec77c4626d9289df97514)。T01–T11 全部在同一提交历史中，远端分支为 `codex/cmp-t11-account-dashboard`。 |
| 本地回归 | 管理后台与 Cloud API 类型检查通过。Vitest 67 个文件、742 项通过。Playwright Chromium 73 项通过。契约测试 321 项通过。OpenAPI、136 条 REST 路由一致性、模块边界、数据库迁移结构及管理后台交付检查通过。QA08 全量原型回归 24 项和 24 份 DOM 快照通过。 |
| 完整验证追验 | 候选 `353d2deb` 的完整 `pnpm verify` 在 `test:scripts` 失败。仅修改验收脚本的修复候选 [`fc1793dc`](https://github.com/inrust/food-digester-platform/commit/fc1793dca6359d5dc16d7f8c6e8e84fcf8520dc5) 完整 `pnpm verify` 通过。 [追验回执](audit/evidence/cmp-t12-353d2deb/target-preflight.json) |
| 目标环境 | CMP-01 至 CMP-44 均为 `NOT_RUN`，其中 P1 为 0/15。远端 `main` 仍为 `97cdd503`。同 SHA 绑定及五角色测试资料为 `BLOCKED`，项目方走查和签收为 `OPEN`。 |
| 发布结论 | `OPEN`。本次走查材料包含合成数据和本地回归结果。 |

[开发计划](CMP管理后台前端改进开发计划.md) · [执行顺序](CMP管理后台前端改进执行顺序与提示词.md) · [候选版本和检查回执](audit/evidence/cmp-t12-353d2deb/local-receipt.json)

## 1. 批次与候选版本

在干净工作树启动检查。逐一执行 `git merge-base --is-ancestor`，并比对各任务提交与远端任务分支。下面列出的 11 个提交全部通过。验收记录单独提交，走查和部署以表中的候选 SHA 标识应用版本。

| 任务 | 纳入候选的提交 | 复验批次 |
| --- | --- | --- |
| T01 | [`e574f601`](https://github.com/inrust/food-digester-platform/commit/e574f60191f6e487e0af20cad0a0b6cc2288f278) | A · 可见关闭入口、键盘、取消与零写请求 |
| T02 | [`0a7adf26`](https://github.com/inrust/food-digester-platform/commit/0a7adf2665726e7219a62805992d5eea4920b93b) | A · 接入详情、审批、拒绝读回 |
| T03 | [`e6031882`](https://github.com/inrust/food-digester-platform/commit/e60318823ee8335caa90439f608d5c47a567fe16) | A · 设备查询目标和筛选按钮 |
| T04 | [`a04640be`](https://github.com/inrust/food-digester-platform/commit/a04640becc25c8e22341fd203c973e0c6865cc45) | A · 耗材服务端校验、ESG 查询与导出 |
| T05 | [`ad1d1778`](https://github.com/inrust/food-digester-platform/commit/ad1d1778045d0878b21d2419cf9b8b229aaab9dc) | B · 中英文筛选、布局和实际请求 |
| T06 | [`d3c2e436`](https://github.com/inrust/food-digester-platform/commit/d3c2e436b51a5cdaddcc7b4c5d731277a1ab1f05) | B · 设备、配置、告警和站点详情 |
| T07 | [`75497720`](https://github.com/inrust/food-digester-platform/commit/7549772076d208e55783015958d48a7ae31784b3) | B · 合约、授权、用户、矩阵和审计 |
| T08 | [`243734b8`](https://github.com/inrust/food-digester-platform/commit/243734b82ab1c3c4a505c06989fe4f54ba563475) | C · 双方向游标、同时间跨页、旧客户端 |
| T09 | [`dacaf73b`](https://github.com/inrust/food-digester-platform/commit/dacaf73b35be12a210f354ab8a656a96351fa312) | D · 五角色、时区、菜单和业务设置 |
| T10 | [`e6f8762b`](https://github.com/inrust/food-digester-platform/commit/e6f8762be9ff560b8c06938ae06917f4fc0644c3) | C · 调度发布、云端生效与投递状态 |
| T11 | [`353d2deb`](https://github.com/inrust/food-digester-platform/commit/353d2deb643b5068450ec77c4626d9289df97514) | C · 账号字段回退和设备预览范围 |

历史分批记录只用于追溯。T01–T04 的独立原始回执本次未找到，当前候选已重跑其关键路径。T05、T06、T07、T09 分批 Playwright 最后全套分别为 58、61、64、66 项通过。T06 首轮全套有 1 项失败，T07 首轮定向有 2 项失败。T08 浏览器 65 项通过，开发期曾有 1 项采集时间 UTC 断言失败，T10 首轮有 2 项无效时间修正后提交失败，T11 首轮有 2 项缺少模拟路由。这些旧结果保留在[回执历史记录](audit/evidence/cmp-t12-353d2deb/local-receipt.json)。本候选的定向服务测试和浏览器重新覆盖相关路径。

本地双语路由覆盖 375、768、1440 像素，布局回归包含 1366×768、1440×900 和 1920×1080，专项窄屏覆盖 320 像素。前述本地回执生成时，全仓 `pnpm verify` 为 `NOT_RUN`。本轮在独立工作树补跑，结果见下文。构建日志保留 Vite 的包体大小告警。

### 完整 `pnpm verify` 补跑

在独立工作树按 `353d2deb` 执行，Vitest 2206 项、契约 321 项通过，脚本测试 1689 项通过、5 项失败。失败记录包括 Playwright 登记的 48 项与实际发现的 73 项不符，证据要求尚未纳入两个新增 API，生产路由数从 134 更新到 136，以及只读迁移清单从 44 更新到 45。原候选在 `test:scripts` 退出，其后的构建和各门禁在该次完整运行中为 `NOT_RUN`。

修复候选按完整 SHA [`fc1793dca6359d5dc16d7f8c6e8e84fcf8520dc5`](https://github.com/inrust/food-digester-platform/commit/fc1793dca6359d5dc16d7f8c6e8e84fcf8520dc5) 单独重跑。八个改动文件均为验收脚本或测试。应用、前端构建定义、OpenAPI、CDK 和迁移 SQL 与原候选字节一致。两个新增 API 纳入真实证据校验，浏览器注册仍需和独立发现精确匹配。完整验证退出 0，包括 2206 项 Vitest、321 项契约、1694 项脚本测试、73 项 Chromium、QA05 的 219 次串并行执行及 QA08 的 24 次快照回归。 [两次验证与日志摘要哈希](audit/evidence/cmp-t12-353d2deb/target-preflight.json)

### 前端构建与 API 契约

| 对象 | 已核对的事实 |
| --- | --- |
| 浏览器构建 | Vite 产物来自候选 SHA。Playwright 用相对路径 `/api/v1` 和合成认证配置构建并启动。入口 HTML、JS、CSS 的 SHA-256 见[本地回执](audit/evidence/cmp-t12-353d2deb/local-receipt.json)。线上静态资源构建标识为 `NOT_RUN`。 |
| 管理 API | Cloud API 在同一 SHA 编译通过。路径版本为 `/api/v1`，OpenAPI 3.1.0，统一契约 `info.version=0.2.0`。包版本 `0.0.0` 为工作区元数据，候选以 SHA 与契约哈希识别。Bundle SHA-256 为 `5d1e026ddd90ddeda495c61c730de7e8a21c65178abe8434e2c7b9a3c17f0e73`。实际部署 API 版本为 `NOT_RUN`。 |
| CMP-23 | `GET /api/v1/admin/media` 新增 `captureTimeOrder=asc/desc`。组合游标保持采集时间和 ID 的稳定顺序。缺省保持旧 ID 升序与旧游标。方向或模式冲突返回 `400 CURSOR_INVALID`。下载鉴权及 URL 期限沿用原契约。两个新增索引位于 `20261119010000_media_capture_sort`。 |
| CMP-16/17 | 发布继续接收 UTC `effectiveAt`，省略后即时生效。新增 `GET /api/v1/admin/configurations/{configurationId}/effective-devices`，要求平台 `config:read`，按设备 ID 分页，空列表与无生效配置有各自返回值。Sync 返回既有载荷结构。各版本的投递状态继续读取独立版本状态接口。 |
| CMP-01 | 新增 `GET /api/v1/admin/account/profile`。服务端按已认证 Cognito 主体查询本人，返回业务 ID 和名称。无业务用户时两字段为 `null`，响应设为 `private, no-store`。 |

[生效契约 Bundle](../contracts/rest/openapi.bundle.json) · [媒体契约](../contracts/rest/admin-media-api.json) · [配置契约](../contracts/rest/admin-configuration-api.json) · [本人资料契约](../contracts/rest/admin-user-api.json) · [媒体索引迁移](../packages/database/prisma/migrations/20261119010000_media_capture_sort/migration.sql)

## 2. 项目方逐项走查

`PASS_LOCAL` 表示该条的核心行为在本次候选的本地自动化中有对应断言。浏览器使用合成 API，服务用例使用本地测试数据库和合成身份。右列为目标环境实测。现场记录时，按 CMP 编号登记角色、语言、视口、最短步骤、预期、实际值以及脱敏截图或请求标识。

| 编号 | 走查步骤与预期 | 本地结果与证据 | 目标 |
| --- | --- | --- | --- |
| CMP-01 | 用长显示名账号登录。确认顶部截断。用 Enter 打开账号详情，核对完整名称、业务 ID、Cognito 用户名和 sub，按 Esc 回到入口。无业务名称的账号依次回退到已验证邮箱或用户名。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-account-dashboard.spec.ts#L7) · [本人资料和越权参数](../apps/cloud-api/test/admin-user.test.ts#L329) | `NOT_RUN` |
| CMP-02 | 用平台和客户账号打开概览。分别用 0、2、13 台数据看总数与预览，最多显示 10 台并保持 ID 升序。打开设备列表，客户账号保持本客户范围。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-account-dashboard.spec.ts) · [服务端范围和顺序](../apps/cloud-api/test/admin-dashboard.test.ts#L396) | `NOT_RUN` |
| CMP-03 | 登录后检查顶部，通知铃铛与徽标隐藏。用有权限角色从现有菜单进入告警页。 | `PASS_LOCAL` [壳层断言](../apps/admin-web/test/shell.test.tsx#L130) · [五角色浏览器](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) | `NOT_RUN` |
| CMP-04 | 以旧 London/纽约偏好打开页面，回退到上海。切换上海与 UTC，核对同一时间在媒体页的显示，重新登录核对默认上海。 | `PASS_LOCAL` [五角色时区](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) · [登录和重置](../apps/admin-web/e2e/qa05-workflows.spec.ts#L129) | `NOT_RUN` |
| CMP-05 | 在查看设备页从授权列表分别选择有区域标签、缺标签及无站点设备。选中前应用禁用，选中后可查询。失败可重试。客户账号仅见本客户可用设备。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-device-query.spec.ts#L6) · [无站点路径](../apps/admin-web/test/device-view.test.tsx#L142) | `NOT_RUN` |
| CMP-06 | 操作设备先查询 A，再把选择改成 B。确认 B 前禁发命令，延迟 A 响应后仍以完成查询的 B 为目标。核对请求路径中的设备 ID。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-device-query.spec.ts#L71) | `NOT_RUN` |
| CMP-07 | 打开操作设备的快捷操作，逐分类检查动作。禁用动作可读到原因。高风险动作复验确认及设备状态限制。 | `PASS_LOCAL` [快捷操作分组](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L145) · [命令门控](../apps/admin-web/test/device-operate.test.tsx#L223) | `NOT_RUN` |
| CMP-08 | 在窄屏切换中英文，选择长命令名并应用命令状态筛选。下拉与筛选按钮均可达，实际过滤值正确。 | `PASS_LOCAL` [双语重叠回归](../apps/admin-web/e2e/cmp-device-query.spec.ts#L162) | `NOT_RUN` |
| CMP-09 | 设备群叠加站点、关键字和状态，翻页后执行单一重置。回到第一页，清空可编辑条件并保留固定客户范围。 | `PASS_LOCAL` [筛选、游标和重置](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L163) | `NOT_RUN` |
| CMP-10 | 从设备群打开设备详情，按区检查四轴状态、生命周期、配置、OTA、备注、证书和分配历史。审计角色入口按权限呈现。 | `PASS_LOCAL` [设备详情与权限](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L210) · [长值](../apps/admin-web/e2e/admin-web.spec.ts#L1287) | `NOT_RUN` |
| CMP-11 | 点待审批记录即打开弹窗，依次检查加载、失败、重试与详情。快速切换记录或标签，关闭后等迟到响应，旧详情保持关闭。审批确认可独立退出。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/admin-web.spec.ts#L226) · [迟到响应](../apps/admin-web/test/onboarding.test.tsx#L165) | `NOT_RUN` |
| CMP-12 | 拒绝待审批记录，核对原因与版本。失败留在详情并可重试。成功关闭并从待审批移除，切换已拒绝标签核对新状态。另验批准后的跳转。 | `PASS_LOCAL` [拒绝读回](../apps/admin-web/e2e/admin-web.spec.ts#L226) · [原因、版本和批准](../apps/admin-web/test/onboarding.test.tsx#L138) | `NOT_RUN` |
| CMP-13 | 打开配置列表，在中英文窄窗口确认有权限时「新建配置」在工具栏最左侧，查询和重置成组。 | `PASS_LOCAL` [工具栏位置](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L131) | `NOT_RUN` |
| CMP-14 | 从列表打开配置详情，核对摘要、目标、派生上下文和版本历史。用加载失败与空方案检查提示和重试。 | `PASS_LOCAL` [详情与空、错状态](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L8) | `NOT_RUN` |
| CMP-15 | 打开多版本方案，确认历史按需展开、高度受限。键盘可到达早期版本并查看只读参数和投递状态。 | `PASS_LOCAL` [24 版本及键盘](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L8) | `NOT_RUN` |
| CMP-16 | 发布草稿。上海录入凌晨及 UTC 录入同一钟点，核对实际 UTC 请求。试非法输入、修正后提交及留空发布，检查原因保留。 | `PASS_LOCAL` [三种真实浏览器输入](../apps/admin-web/e2e/cmp-configuration-effective.spec.ts#L175) | `NOT_RUN` |
| CMP-17 | 查同型号多台设备、设备定向覆盖、未来版本和无配置。翻页并对照 Sync 解析。分别查两版投递，缺可信应用回执的设备显示「未知」。 | `PASS_LOCAL` [分页 UI 与投递](../apps/admin-web/e2e/cmp-configuration-effective.spec.ts#L31) · [解析与权限](../apps/cloud-api/test/admin-configuration.test.ts#L465) | `NOT_RUN` |
| CMP-18 | 在耗材状态和申请区填设备、站点或余量，检查标签、动作和实际查询参数，窄屏双语可读。 | `PASS_LOCAL` [双语和查询](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L55) | `NOT_RUN` |
| CMP-19 | 新建耗材申请从有权设备中选择。选中后模拟失效，应在设备字段旁报错。分别验不存在、未分配、已退役、越权、合法和重复申请。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-consumable-esg.spec.ts#L5) · [服务端拒绝和幂等](../apps/cloud-api/test/admin-consumable-request.test.ts#L206) | `NOT_RUN` |
| CMP-20 | 逐个切换告警、事件和防拆，确认可见条件与实际 endpoint 一致，长筛选值下仍能查询与重置。 | `PASS_LOCAL` [三标签查询](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L79) | `NOT_RUN` |
| CMP-21 | 打开已清除及待处理告警，核对状态、发生/清除时间和原因。检查证据图片入口与确认/清除权限。 | `PASS_LOCAL` [详情布局与只读门控](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L210) · [证据图片](../apps/admin-web/e2e/evidence-image.spec.ts) | `NOT_RUN` |
| CMP-22 | 用平台与客户角色打开媒体，验证设备、客户、类型、状态和日期控件权限及窄屏可读性。按键执行查询并核对条件。 | `PASS_LOCAL` [媒体筛选](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L105) · [媒体组件和传输](../apps/admin-web/test/media.test.tsx) | `NOT_RUN` |
| CMP-23 | 用多个同采集时间文件检查正倒序相邻两页，无重复遗漏。切换排序或筛选回首页，错误游标被拒绝，旧客户端和下载继续可用。 | `PASS_LOCAL` [换向和迟到响应](../apps/admin-web/e2e/cmp-media-capture-sort.spec.ts#L25) · [双向游标、旧客户端与租户](../apps/cloud-api/test/media.test.ts#L591) | `NOT_RUN` |
| CMP-24 | ESG 概览切统计粒度、客户及日期并应用。核对查询范围、时区、估算说明与导出入口。 | `PASS_LOCAL` [筛选栏](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L113) · [导出与时区](../apps/admin-web/e2e/qa05-workflows.spec.ts#L197) | `NOT_RUN` |
| CMP-25 | 设备 ESG 分别在已应用、分页和日期错误状态重置。立即导出，再重新查询，核对日期、设备、游标被清除且保留固定客户范围。 | `PASS_LOCAL` [查询与导出请求](../apps/admin-web/e2e/cmp-consumable-esg.spec.ts#L81) | `NOT_RUN` |
| CMP-26 | 合约列表选择长客户名，在小视口用筛选按钮。检查按钮和下拉可独立操作，所选客户能进入查询参数。 | `PASS_LOCAL` [双语重叠回归](../apps/admin-web/e2e/cmp-device-query.spec.ts#L162) | `NOT_RUN` |
| CMP-27 | 打开合约详情，检查摘要、期限、许可的联系人字段、关联设备与记录。再走编辑、续约、关联和解绑，核对 License 的独立状态。 | `PASS_LOCAL` [详情和门控](../apps/admin-web/test/contracts.test.tsx#L346) · [浏览器写入与读回](../apps/admin-web/e2e/admin-web.spec.ts#L1053) | `NOT_RUN` |
| CMP-28 | 合约详情打开关联设备。在加载、无候选和提交错误态退出，焦点返回原按钮，没有额外写入。迟到请求不会填入新弹窗。 | `PASS_LOCAL` [加载与空候选](../apps/admin-web/test/contracts.test.tsx#L485) · [浏览器零写](../apps/admin-web/e2e/admin-web.spec.ts#L1189) | `NOT_RUN` |
| CMP-29 | 合约编辑改名后分别关掉、取消。检查零写、焦点和重开后的保存值，再用原因和版本走合法保存。 | `PASS_LOCAL` [关闭、取消与读回](../apps/admin-web/e2e/admin-web.spec.ts#L1181) · [并发版本](../apps/admin-web/test/contracts.test.tsx#L397) | `NOT_RUN` |
| CMP-30 | 续约录无效时间或空原因后取消，核对零写和入口焦点。重开输入合法时间与原因，检查版本更新和保存反馈。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/admin-web.spec.ts#L1207) · [续约门控](../apps/admin-web/test/contracts.test.tsx#L415) | `NOT_RUN` |
| CMP-31 | 用五种角色检查「授权管理」菜单和直达路径。获授权角色可跨设备查询和按权限写入，审计角色只读。 | `PASS_LOCAL` [角色路由与按钮](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) · [授权服务与审计](../apps/cloud-api/test/admin-license.test.ts) | `NOT_RUN` |
| CMP-32 | 在独立 License 详情核对设备、有效期、Entitlement、状态历史与操作区。试无权限角色、到期记录与写入后的读回。 | `PASS_LOCAL` [License 详情与权限](../apps/admin-web/test/licenses.test.tsx) | `NOT_RUN` |
| CMP-33 | 在业务设置编辑输入无效 JSON 后取消。重开读回原值，零写。提交合法值携版本，冲突可刷新回源。 | `PASS_LOCAL` [取消、版本与冲突](../apps/admin-web/e2e/admin-web.spec.ts#L1035) · [后端冲突](../apps/cloud-api/test/admin-settings.test.ts#L159) | `NOT_RUN` |
| CMP-34 | 看四项设置的用途、消费方、运行时状态和可编辑性。核对耗材告警阈值、命令认证时间窗以及两个仅存储项。 | `PASS_LOCAL` [FE-18 消费范围](../apps/admin-web/e2e/cmp-settings-runtime.spec.ts#L5) · [BE-CMD-01 时间窗](../apps/cloud-api/test/admin-command.test.ts#L267) | `NOT_RUN` |
| CMP-35 | 打开平台用户表格，检查长邮箱、显示名和客户 ID 的完整值查看方式，窄屏仍能访问操作列。 | `PASS_LOCAL` [长值和行内入口](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L8) | `NOT_RUN` |
| CMP-36 | 改角色后打开二次确认。Esc 关闭最上层，取消或关闭原表单不写入，焦点回原行。重开读回原角色，再确认一次写入。 | `PASS_LOCAL` [嵌套焦点及零写](../apps/admin-web/e2e/admin-web.spec.ts#L994) · [角色服务权限](../apps/cloud-api/test/admin-user.test.ts) | `NOT_RUN` |
| CMP-37 | 打开只读权限矩阵，按模块和权限找角色。逐列对照共享角色授权，确认无编辑入口。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L8) · [共享定义断言](../apps/admin-web/test/settings.test.tsx#L273) | `NOT_RUN` |
| CMP-38 | 从独立设备用户页打开详情，核对账号、分配历史、通知投递、Sync 确认和实际应用状态。越权角色看不到写入口。 | `PASS_LOCAL` [状态分区](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L61) · [客户只读](../apps/admin-web/e2e/admin-web.spec.ts#L42) | `NOT_RUN` |
| CMP-39 | 修改设备用户资料，试空原因与请求失败。取消返回且不改写，成功写入带版本与原因并回读。 | `PASS_LOCAL` [失败可退、读回及 If-Match](../apps/admin-web/test/device-users.test.tsx#L284) | `NOT_RUN` |
| CMP-40 | 用平台和客户角色查看站点筛选，检查客户、区域、子区域、状态和独立新建操作。核对既有查询行为与固定客户范围。 | `PASS_LOCAL` [站点筛选布局和请求](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L121) · [站点服务范围](../apps/cloud-api/test/admin-site.test.ts) | `NOT_RUN` |
| CMP-41 | 在列表滚动后打开某站点详情。失败可重试，Esc 关闭恢复同一行焦点与滚动。按角色验编辑、停用及其版本。 | `PASS_LOCAL` [小视口、焦点与版本](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L126) | `NOT_RUN` |
| CMP-42 | 以五种角色核对用户管理、独立设备用户入口和直达路径。打开用户管理时检查后台请求，设备用户列表只在进入主页面后加载。 | `PASS_LOCAL` [角色矩阵及请求计数](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) | `NOT_RUN` |
| CMP-43 | 审计日志用长操作人或对象 ID 叠加动作、结果和时间。可操作查询与重置，参数按可见权限和显示时区生效。 | `PASS_LOCAL` [双语筛选](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L124) · [筛选与权限](../apps/admin-web/test/audit-logs.test.tsx#L82) | `NOT_RUN` |
| CMP-44 | 查看含长 JSON 的审计详情。前后值可独立滚动，敏感字段脱敏。关闭按钮及 Esc 可退出，Tab 留在当前对话框并恢复焦点。 | `PASS_LOCAL` [浏览器焦点与长 JSON](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L138) · [服务端脱敏](../apps/cloud-api/test/admin-audit.test.ts#L286) | `NOT_RUN` |

## 3. 目标环境走查安排

拿到同一候选的前端发布记录、管理 API 部署回执和 OpenAPI 哈希后，再录制目标结果。用两组授权测试租户验证隔离。准备五种角色账号、审批记录、可控设备、耗材、媒体、合约、配置、告警和审计样本。涉及审批、发命令、设置、授权和合约变更的步骤使用批准的测试记录。以账号角色和租户别名记录证据，截图、请求摘要和导出样本按项目方约定保管。

| 场次 | 走查路径 | 要留的证据 |
| --- | --- | --- |
| A · 关键业务 | 平台管理员在中文和英文中操作审批、关联、续约、设置与角色确认。设备操作员验证 A/B 查询目标。客户角色验证耗材申报和 ESG 重置、导出。 | 默认及 375 像素窄屏。记录关闭、取消的零写请求，保存时的版本、原因、读回状态与 requestId。查询、导出和命令保存脱敏请求参数，证明使用正确目标及租户。 |
| B · 可读性与焦点 | 平台管理员、审计员和客户管理员走筛选、详情、告警与审计。用 1366×768、1440×900 和窄屏检查长值、空状态和滚动区域。 | 中英文截图，Tab、Shift+Tab、Escape 的焦点轨迹，脱敏后的审计记录及只读操作状态。 |
| C/D · 数据与权限 | 五角色核对菜单、直达路径和写权限。验证账号回退、概览 0/少量/超 10 台、两种时区、媒体相邻页和配置生效。 | 前端构建 SHA、管理 API 版本和 Bundle 哈希。保留媒体两页合成 ID、排序方向和旧客户端返回。配置保留版本、来源和独立投递状态。记录业务设置消费行为。 |

项目方签收逐条回填 `PASS`、`FAIL` 或 `NOT_RUN`。失败项保留候选版本、环境、复现步骤及读回证据。需要补测的条目保持 `OPEN`，直到取得对应结果。

### 同 SHA 发布路径和测试数据核对

| 检查项 | 本轮结果 |
| --- | --- |
| 前端 | 仓库配置的测试发布入口为 Amplify Hosting 的 `main` 分支。Monorepo 构建使用 `amplify.yml`，发布 `apps/admin-web/dist/web`。本轮未取得候选的 Amplify Job 与资源哈希回执。 [构建配置](../amplify.yml) · [托管分支](../infra/src/stacks/app-dependencies-stack.ts#L241) |
| 管理 API | `Deploy test API` 在 `main` 上先跑完整 `pnpm verify`，再由 OIDC 进入测试账号执行 CDK。已核对 GitHub 部署开关为 `true`，远端 `main` 为 `97cdd503`。该历史部署作业成功。此次候选的部署及 Lambda 产物绑定仍为 `NOT_RUN`。 [部署流程](../.github/workflows/deploy-test.yml) · [历史部署](https://github.com/inrust/food-digester-platform/actions/runs/43667829780) |
| 契约和媒体索引 | 统一 OpenAPI SHA-256 为 `5d1e026ddd90ddeda495c61c730de7e8a21c65178abe8434e2c7b9a3c17f0e73`。媒体索引使用固定源码 SHA 和 S3 VersionId 的 CodeBuild Migration Runner。已在本机打包并复核候选 SHA 与 SQL 哈希。目标迁移和索引读回为 `NOT_RUN`。 [部署与迁移手册](AWS测试环境部署配置与执行手册.md#5-migration-runner-操作边界) |
| AWS 只读复核 | AWS 只读会话续签前的两次 STS 预检均返回 `SSO_INVALID_OR_EXPIRED`，因此实际 Amplify、测试栈和 Cognito 组盘点未执行。 |
| 五角色资料 | `BLOCKED`。目前未验证项目方批准的五角色账号可登录、两组租户与各样本归属，亦未取得批准的写操作及清理台账。历史 QA09 账号与清理记录仅供设计测试材料时参考。 |

| 角色 | 本轮需核对的受控材料 | 目标证据 |
| --- | --- | --- |
| PlatformSuperAdmin | 待审批与拒绝样本、合约、设置、角色变更和审计记录。写操作需批准的原因、版本与清理台账。 | `NOT_RUN` |
| PlatformOperator | 两台可测试设备、授权状态和命令控制范围，能安全核对请求目标及拒绝状态。 | `NOT_RUN` |
| Auditor | 允许查看的配置、授权与审计数据，以及只读界面和服务端拒写证据。 | `NOT_RUN` |
| CustomerAdmin | 已批准的本租户设备和耗材、ESG 日期与分页样本。准备外租户 ID 供验证拒绝。 | `NOT_RUN` |
| CustomerViewer | 非空但可只读的本租户数据，以及另一租户的拒绝样本。 | `NOT_RUN` |

P1 首批为 CMP-05、06、08、11、12、19、25、26、28、29、30、33、36、39、44。前端构建记录、API 部署与 Lambda 产物、OpenAPI 清单和数据库迁移均绑定同一批准 SHA 后，先验证这 15 项，再回填其余 29 项。在同 SHA 绑定或测试材料缺失时保留逐项 `NOT_RUN`。本轮目标实测暂无通过或失败判定。

## 4. 发布待办与回退版本

| 状态 | 待办与放行条件 |
| --- | --- |
| `FAIL` · 原候选完整验证 | `353d2deb` 有 5 个脚本门禁失败，现有发布工作流会在此停止。修复候选的完整验证和 SHA 见追验回执。 |
| `BLOCKED` · 目标版本 | 待明确批准实际发布 SHA、共享测试 `main` 发布和媒体索引迁移。发布后收集同一 SHA 的前端、API、契约和迁移回执。 |
| `BLOCKED` · 目标数据 | 需要五角色测试账号、两组授权测试租户及批准的数据和写入范围。先复验 P1 的审批、弹窗零写、设备查询、耗材及 ESG，再恢复其他目标实测。 |
| `OPEN` · 项目方验收 | 目标 44 项目前均为 `NOT_RUN`。完成中英文、典型视口、键盘和租户验证后签收。 |
| `OPEN` · CMP-23 目标迁移 | 目标环境执行前确认媒体索引迁移窗口与 DDL 锁影响，执行后核对两类索引、双向分页和旧客户端。实际变更与目标查询计划为 `NOT_RUN`。 |
| `OPEN` · D5 可信回执 | 设备协议当前缺少可信的配置版本应用回执，界面显示「未知」。该显示已符合本轮确认口径。回执接入单独评估。 |

远端 `main` 核对为 `97cdd503db32f350a4f1d283b70200c817bbf8c1`。该 SHA 对应的历史部署作业完成了输入核对、目标账号与 SHA 校验及 AppDependencies 部署。待回退前仍须核对目标环境当前的前端产物、API 版本及数据库迁移记录。 [历史部署作业](https://github.com/inrust/food-digester-platform/actions/runs/43667829780)

| 失败范围 | 可回退的源码版本 | 回退注意点 |
| --- | --- | --- |
| 整体候选或工作包 A | [`97cdd503`](https://github.com/inrust/food-digester-platform/commit/97cdd503db32f350a4f1d283b70200c817bbf8c1) | 前端与管理 API 成对回退。先查目标现存版本、对应构建产物和迁移状态。 |
| 工作包 B 布局与详情 | [`a04640be`](https://github.com/inrust/food-digester-platform/commit/a04640becc25c8e22341fd203c973e0c6865cc45)（T04 后） | 保留工作包 A。后续批次随该版本整体退回。 |
| CMP-23 媒体接口或排序 | [`75497720`](https://github.com/inrust/food-digester-platform/commit/7549772076d208e55783015958d48a7ae31784b3)（T07 后） | 先停用新版排序 UI 或成对回退，重新从首页取旧 ID 游标。已加的普通索引可保留。索引清理由部署方单独评估。 |
| 工作包 D 顶栏和导航决定 | [`243734b8`](https://github.com/inrust/food-digester-platform/commit/243734b82ab1c3c4a505c06989fe4f54ba563475)（T08 后） | 保留媒体兼容契约。T10、T11 随 T09 成对回退。 |
| CMP-16/17 配置发布与展示 | [`dacaf73b`](https://github.com/inrust/food-digester-platform/commit/dacaf73b35be12a210f354ab8a656a96351fa312)（T09 后） | 核对业务记录和已有配置版本，匹配前端与 API 版本。 |
| CMP-01/02 账号与概览 | [`e6f8762b`](https://github.com/inrust/food-digester-platform/commit/e6f8762be9ff560b8c06938ae06917f4fc0644c3)（T10 后） | 保留 T10。按已留存的同版本构建与 API 产物回退。 |

分批回退的源码点已核对。其目标环境回退演练为 `NOT_RUN`，执行前须确认对应已验证的发布产物。历史主分支部署记录仅用于回退参考。
