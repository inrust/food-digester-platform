# CMP 管理后台候选版本验收与项目方走查

2026-11-19 · 工作包 E / T12

| 项目 | 当前结论 |
| --- | --- |
| 验收候选 | [`d1afec5e`](https://github.com/inrust/food-digester-platform/commit/d1afec5ec12ad78a3aeb0bccb864b6f25e3439f8)。前端构建 172、管理 API、OpenAPI、固定 Migration Runner 和托管验证均绑定该 SHA。 [同 SHA 回执](audit/evidence/cmp-t12-353d2deb/target-reset-follow-up-d1afec5e.json) |
| 本地回归 | [`d1afec5e`](https://github.com/inrust/food-digester-platform/commit/d1afec5ec12ad78a3aeb0bccb864b6f25e3439f8) 完整 `pnpm verify` 退出 0，已登记四项双语重置回归。管理后台类型检查、定向 Vitest 24 项及定向 Playwright 7 项通过。 [本轮检查](audit/evidence/cmp-t12-353d2deb/target-reset-follow-up-d1afec5e.json) |
| 完整验证追验 | 候选 `353d2deb` 的完整 `pnpm verify` 在 `test:scripts` 失败。仅修改验收脚本的修复候选 [`fc1793dc`](https://github.com/inrust/food-digester-platform/commit/fc1793dca6359d5dc16d7f8c6e8e84fcf8520dc5) 完整 `pnpm verify` 通过。 [追验回执](audit/evidence/cmp-t12-353d2deb/target-preflight.json) |
| 目标环境 | 原候选 `fc1793dc` 的共享测试环境四项版本证据已对齐。原候选 44 项验收索引为 10 项 PASS、1 项 FAIL、33 项 NOT_RUN，其中 31 项有部分实测记录。P1 首批为 5 项 PASS、0 项 FAIL、10 项 NOT_RUN，其中 9 项有部分实测记录。 [目标实测回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json) |
| CMP-23 跟进 | [`07a385f4`](https://github.com/inrust/food-digester-platform/commit/07a385f4a1193e70334b9438914b0e1e2d9cca76) 已独立完成全量验证、发布和同 SHA 绑定。CMP-23 `PASS`，发布阻塞 `RESOLVED`。 [修复回执](audit/evidence/cmp-t12-353d2deb/target-cmp23-follow-up-07a385f4.json) |
| 发布结论 | `PASS` · 本次约定范围 44 项通过，含 CMP-34 按已确认的合成分档范围签收。真实耗材采集链路保留 `NOT_RUN` 并转后续。 [签收回执](audit/evidence/cmp-t12-353d2deb/target-signoff-d1afec5e.json) |

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
| CMP-01 | 用长显示名账号登录。确认顶部截断。用 Enter 打开账号详情，核对完整名称、业务 ID、Cognito 用户名和 sub，按 Esc 回到入口。无业务名称的账号依次回退到已验证邮箱或用户名。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-account-dashboard.spec.ts#L7) · [本人资料和越权参数](../apps/cloud-api/test/admin-user.test.ts#L329) | `PASS` · 专用客户业务 displayName、业务 userId、Cognito 登录标识和键盘入口均读回。窄屏截断并提供完整文本。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L235) |
| CMP-02 | 用平台和客户账号打开概览。分别用 0、2、13 台数据看总数与预览，最多显示 10 台并保持 ID 升序。打开设备列表，客户账号保持本客户范围。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-account-dashboard.spec.ts) · [服务端范围和顺序](../apps/cloud-api/test/admin-dashboard.test.ts#L396) | `PASS` · 专用空租户 C 以真实 CustomerViewer 会话实测。概览和设备列表均为零，双语窄屏可键盘进入列表，搜索另一组的专用设备仍为空，显式异租户查询和异租户设备直达返回 403。前轮大于 10 台、设备 ID 顺序及两组有设备的数据继续保留。 [签收回执](audit/evidence/cmp-t12-353d2deb/target-signoff-d1afec5e.json#L344) |
| CMP-03 | 登录后检查顶部，通知铃铛与徽标隐藏。用有权限角色从现有菜单进入告警页。 | `PASS_LOCAL` [壳层断言](../apps/admin-web/test/shell.test.tsx#L130) · [五角色浏览器](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) | `PASS` · 实际顶部栏没有通知铃入口。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L315) |
| CMP-04 | 以旧 London/纽约偏好打开页面，回退到上海。切换上海与 UTC，核对同一时间在媒体页的显示，重新登录核对默认上海。 | `PASS_LOCAL` [五角色时区](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) · [登录和重置](../apps/admin-web/e2e/qa05-workflows.spec.ts#L129) | `PASS` · 实际页面仅有上海、UTC，原偏好回退上海，UTC 刷新后保留并可切回。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L381) |
| CMP-05 | 在查看设备页从授权列表分别选择有区域标签、缺标签及无站点设备。选中前应用禁用，选中后可查询。失败可重试。客户账号仅见本客户可用设备。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-device-query.spec.ts#L6) · [无站点路径](../apps/admin-web/test/device-view.test.tsx#L142) | `PASS` · 客户访问失败重试、租户路径和无地区标签的平台直接查询均通过。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L447) |
| CMP-06 | 操作设备先查询 A，再把选择改成 B。确认 B 前禁发命令，延迟 A 响应后仍以完成查询的 B 为目标。核对请求路径中的设备 ID。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-device-query.spec.ts#L71) | `PASS` · 真实迟到和重试不会恢复旧目标，真实命令只下发到已应用纯模拟设备。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L502) |
| CMP-07 | 打开操作设备的快捷操作，逐分类检查动作。禁用动作可读到原因。高风险动作复验确认及设备状态限制。 | `PASS_LOCAL` [快捷操作分组](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L145) · [命令门控](../apps/admin-web/test/device-operate.test.tsx#L223) | `PASS` · 中英文分别实测离线有授权、在线运行有授权、在线运行无 REMOTE_CONTROL。两类禁用理由均与按钮关联。高风险加热需输入准确确认文本，Escape 退出，实际命令 POST 为 0。 [补验回执](audit/evidence/cmp-t12-353d2deb/target-sample-follow-up-d1afec5e.json#L974) |
| CMP-08 | 在窄屏切换中英文，选择长命令名并应用命令状态筛选。下拉与筛选按钮均可达，实际过滤值正确。 | `PASS_LOCAL` [双语重叠回归](../apps/admin-web/e2e/cmp-device-query.spec.ts#L162) | `PASS` · 375/768/1440 显示无重叠，长命令标签实际提交到查询。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L591) |
| CMP-09 | 设备群叠加站点、关键字和状态，翻页后执行单一重置。回到第一页，清空可编辑条件并保留固定客户范围。 | `PASS_LOCAL` [筛选、游标和重置](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L163) | `PASS` · 客户组筛选、真正第二页、单一重置及固定租户均通过。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L639) |
| CMP-10 | 从设备群打开设备详情，按区检查四轴状态、生命周期、配置、OTA、备注、证书和分配历史。审计角色入口按权限呈现。 | `PASS_LOCAL` [设备详情与权限](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L210) · [长值](../apps/admin-web/e2e/admin-web.spec.ts#L1287) | `PASS` · 专用模拟设备的真实详情在异步签发前返回 certificate=null，分配历史为空，两个页面空态均可见。审计员从设备群进入同一设备，编辑和轮换禁用。客户直达被拒。 [补验回执](audit/evidence/cmp-t12-353d2deb/target-sample-follow-up-d1afec5e.json#L1005) |
| CMP-11 | 点待审批记录即打开弹窗，依次检查加载、失败、重试与详情。快速切换记录或标签，关闭后等迟到响应，旧详情保持关闭。审批确认可独立退出。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/admin-web.spec.ts#L226) · [迟到响应](../apps/admin-web/test/onboarding.test.tsx#L165) | `PASS` · 审批详情连接失败可重试，嵌套确认独立关闭，带版本批准并按设备序列号导航。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L807) |
| CMP-12 | 拒绝待审批记录，核对原因与版本。失败留在详情并可重试。成功关闭并从待审批移除，切换已拒绝标签核对新状态。另验批准后的跳转。 | `PASS_LOCAL` [拒绝读回](../apps/admin-web/e2e/admin-web.spec.ts#L226) · [原因、版本和批准](../apps/admin-web/test/onboarding.test.tsx#L138) | `PASS` · 中止的首次拒绝保留详情和重试入口。实际重试带原因与当前版本，关闭后移出待审批，在已拒绝标签读回。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L853) |
| CMP-13 | 打开配置列表，在中英文窄窗口确认有权限时「新建配置」在工具栏最左侧，查询和重置成组。 | `PASS_LOCAL` [工具栏位置](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L131) | `PASS` · 新建配置位于工具栏第一个操作，Escape 恢复焦点。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L898) |
| CMP-14 | 从列表打开配置详情，核对摘要、目标、派生上下文和版本历史。用加载失败与空方案检查提示和重试。 | `PASS_LOCAL` [详情与空、错状态](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L8) | `PASS` · 真实多版历史可独立展开。首次详情连接失败后可退出重开，专用空方案直接展示空历史。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L920) |
| CMP-15 | 打开多版本方案，确认历史按需展开、高度受限。键盘可到达早期版本并查看只读参数和投递状态。 | `PASS_LOCAL` [24 版本及键盘](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L8) | `PASS` · 八个真实未发布版本形成滚动容器，派生站点展示与 API 一致。审计员能访问最早版本且无发布权限。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L959) |
| CMP-16 | 发布草稿。上海录入凌晨及 UTC 录入同一钟点，核对实际 UTC 请求。试非法输入、修正后提交及留空发布，检查原因保留。 | `PASS_LOCAL` [三种真实浏览器输入](../apps/admin-web/e2e/cmp-configuration-effective.spec.ts#L175) | `PASS` · 原生 datetime-local 输入毫秒时展示错误且提交禁用，没有请求。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L1082) |
| CMP-17 | 查同型号多台设备、设备定向覆盖、未来版本和无配置。翻页并对照 Sync 解析。分别查两版投递，缺可信应用回执的设备显示「未知」。 | `PASS_LOCAL` [分页 UI 与投递](../apps/admin-web/e2e/cmp-configuration-effective.spec.ts#L31) · [解析与权限](../apps/cloud-api/test/admin-configuration.test.ts#L465) | `PASS` · 两真实相邻页各一台，设备定向和型号定向各自胜出。与对应版冻结参数逐项比对，两次真实 mTLS Sync 一致。逐版本通知包含实际目标，无匹配应用回执继续显示未知。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L1147) |
| CMP-18 | 在耗材状态和申请区填设备、站点或余量，检查标签、动作和实际查询参数，窄屏双语可读。 | `PASS_LOCAL` [双语和查询](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L55) | `PASS` · 两种列表按真实请求保留固定租户，耗材状态筛选重置清除占比，申请查询进入指定自有设备。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L1372) |
| CMP-19 | 新建耗材申请从有权设备中选择。选中后模拟失效，应在设备字段旁报错。分别验不存在、未分配、已退役、越权、合法和重复申请。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-consumable-esg.spec.ts#L5) · [服务端拒绝和幂等](../apps/cloud-api/test/admin-consumable-request.test.ts#L206) | `PASS` · 受控设备提交前真实退役，服务端拒绝与字段提示一致。不存在、未分配、越权、合法及幂等也通过。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L1416) |
| CMP-20 | 逐个切换告警、事件和防拆，确认可见条件与实际 endpoint 一致，长筛选值下仍能查询与重置。 | `PASS_LOCAL` [三标签查询](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L79) | `PASS` · 告警、事件和防拆分别在中英文窄屏验证真实第二页。独立重置清除草稿、已应用条件、游标和 URL 筛选，保留当前标签及固定客户范围。默认查询在第二页原地重置也回到第一项。两租户的可见范围已逐接口读回。 [修复回执](audit/evidence/cmp-t12-353d2deb/target-reset-follow-up-d1afec5e.json#L1420) |
| CMP-21 | 打开已清除及待处理告警，核对状态、发生/清除时间和原因。检查证据图片入口与确认/清除权限。 | `PASS_LOCAL` [详情布局与只读门控](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L210) · [证据图片](../apps/admin-web/e2e/evidence-image.spec.ts) | `PASS` · 实际告警确认与清除已读回。另一个专用告警从详情读回已关联图片，授权浏览器加载真实像素，外租户详情和签发均为 404。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L1645) |
| CMP-22 | 用平台与客户角色打开媒体，验证设备、客户、类型、状态和日期控件权限及窄屏可读性。按键执行查询并核对条件。 | `PASS_LOCAL` [媒体筛选](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L105) · [媒体组件和传输](../apps/admin-web/test/media.test.tsx) | `PASS` · 客户窄屏按设备、类型查询已修复的实际媒体列表，返回四条自有样本且无法跳出固定租户。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L1998) |
| CMP-23 | 用多个同采集时间文件检查正倒序相邻两页，无重复遗漏。切换排序或筛选回首页，错误游标被拒绝，旧客户端和下载继续可用。 | `PASS_LOCAL` [换向和迟到响应](../apps/admin-web/e2e/cmp-media-capture-sort.spec.ts#L25) · [双向游标、旧客户端与租户](../apps/cloud-api/test/media.test.ts#L591) | `PASS` · 修复候选 [`07a385f4`](https://github.com/inrust/food-digester-platform/commit/07a385f4a1193e70334b9438914b0e1e2d9cca76)。共享测试已按三种模式和两个租户验证分页，浏览器双语验证换向和筛选归第一页。 [修复回执](audit/evidence/cmp-t12-353d2deb/target-cmp23-follow-up-07a385f4.json) · [原候选 500 历史](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2051) |
| CMP-24 | ESG 概览切统计粒度、客户及日期并应用。核对查询范围、时区、估算说明与导出入口。 | `PASS_LOCAL` [筛选栏](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L113) · [导出与时区](../apps/admin-web/e2e/qa05-workflows.spec.ts#L197) | `PASS` · 真实 UTC 区间、周统计和估算说明已核对。实际导出保留查询区间与固定客户并创建作业。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2047) |
| CMP-25 | 设备 ESG 分别在已应用、分页和日期错误状态重置。立即导出，再重新查询，核对日期、设备、游标被清除且保留固定客户范围。 | `PASS_LOCAL` [查询与导出请求](../apps/admin-web/e2e/cmp-consumable-esg.spec.ts#L81) | `PASS` · 两条真实 MQTT 报告产生分页，日期错误重置后查询、导出和重选均验证固定租户与游标。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2103) |
| CMP-26 | 合约列表选择长客户名，在小视口用筛选按钮。检查按钮和下拉可独立操作，所选客户能进入查询参数。 | `PASS_LOCAL` [双语重叠回归](../apps/admin-web/e2e/cmp-device-query.spec.ts#L162) | `PASS` · 375/768/1440 控件独立无交叠，合约筛选实际提交专用客户。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2220) |
| CMP-27 | 打开合约详情，检查摘要、期限、许可的联系人字段、关联设备与记录。再走编辑、续约、关联和解绑，核对 License 的独立状态。 | `PASS_LOCAL` [详情和门控](../apps/admin-web/test/contracts.test.tsx#L346) · [浏览器写入与读回](../apps/admin-web/e2e/admin-web.spec.ts#L1053) | `PASS` · 真实关联撤销后仍能查到 ENDED 历史。原设备独立 License 继续有效，合约历史区域可见。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2268) |
| CMP-28 | 合约详情打开关联设备。在加载、无候选和提交错误态退出，焦点返回原按钮，没有额外写入。迟到请求不会填入新弹窗。 | `PASS_LOCAL` [加载与空候选](../apps/admin-web/test/contracts.test.tsx#L485) · [浏览器零写](../apps/admin-web/e2e/admin-web.spec.ts#L1189) | `PASS` · 真实慢响应、错误与空候选都可退出，焦点回原按钮，关闭不写入。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2349) |
| CMP-29 | 合约编辑改名后分别关掉、取消。检查零写、焦点和重开后的保存值，再用原因和版本走合法保存。 | `PASS_LOCAL` [关闭、取消与读回](../apps/admin-web/e2e/admin-web.spec.ts#L1181) · [并发版本](../apps/admin-web/test/contracts.test.tsx#L397) | `PASS` · 可见关闭与取消不发送写入，重开读回之前版本。对空合约的实际提交包含原因、版本和反馈，服务端读回生效。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2496) |
| CMP-30 | 续约录无效时间或空原因后取消，核对零写和入口焦点。重开输入合法时间与原因，检查版本更新和保存反馈。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/admin-web.spec.ts#L1207) · [续约门控](../apps/admin-web/test/contracts.test.tsx#L415) | `PASS` · 可见关闭与取消不发送写入，重开读回之前版本。对空合约的实际提交包含原因、版本和反馈，服务端读回生效。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2543) |
| CMP-31 | 用五种角色检查「授权管理」菜单和直达路径。获授权角色可跨设备查询和按权限写入，审计角色只读。 | `PASS_LOCAL` [角色路由与按钮](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) · [授权服务与审计](../apps/cloud-api/test/admin-license.test.ts) | `PASS` · 按现有状态机使用专用即将到期授权。审计员真实拒写，平台操作员实际续期并产生新版本。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2590) |
| CMP-32 | 在独立 License 详情核对设备、有效期、Entitlement、状态历史与操作区。试无权限角色、到期记录与写入后的读回。 | `PASS_LOCAL` [License 详情与权限](../apps/admin-web/test/licenses.test.tsx) | `PASS` · 仅对额外专用模拟器的 License 模拟评估时间，状态过期及历史实际读回。详情展示独立区域，跨租户拒绝。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2690) |
| CMP-33 | 在业务设置编辑输入无效 JSON 后取消。重开读回原值，零写。提交合法值携版本，冲突可刷新回源。 | `PASS_LOCAL` [取消、版本与冲突](../apps/admin-web/e2e/admin-web.spec.ts#L1035) · [后端冲突](../apps/cloud-api/test/admin-settings.test.ts#L159) | `PASS` · 同值保存、实际请求体版本冲突、非法输入与关闭返回均通过。审计记录一次测试导致的同值版本递增。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L2772) |
| CMP-34 | 看四项设置的用途、消费方、运行时状态和可编辑性。核对耗材告警阈值、命令认证时间窗以及两个仅存储项。 | `PASS_LOCAL` [FE-18 消费范围](../apps/admin-web/e2e/cmp-settings-runtime.spec.ts#L5) · [BE-CMD-01 时间窗](../apps/cloud-api/test/admin-command.test.ts#L267) | `PASS` · 按合成分档范围签收 · 按本次用户确认签收候选浏览器的合成分档。真实设置与 unknown（未上报）展示沿用已通过回执。真实耗材采集、投影及实际自定义阈值的全链路保留 NOT_RUN，并列为后续。 [签收回执](audit/evidence/cmp-t12-353d2deb/target-signoff-d1afec5e.json#L703) |
| CMP-35 | 打开平台用户表格，检查长邮箱、显示名和客户 ID 的完整值查看方式，窄屏仍能访问操作列。 | `PASS_LOCAL` [长值和行内入口](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L8) | `PASS` · 窄屏专用长业务用户表格可到达操作列，键盘打开后能读取完整显示名、地址及客户范围。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3021) |
| CMP-36 | 改角色后打开二次确认。Esc 关闭最上层，取消或关闭原表单不写入，焦点回原行。重开读回原角色，再确认一次写入。 | `PASS_LOCAL` [嵌套焦点及零写](../apps/admin-web/e2e/admin-web.spec.ts#L994) · [角色服务权限](../apps/cloud-api/test/admin-user.test.ts) | `PASS` · 专用业务用户的嵌套键盘、关闭、取消零写及真实权限写入和审计全部通过，已恢复为只读。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3043) |
| CMP-37 | 打开只读权限矩阵，按模块和权限找角色。逐列对照共享角色授权，确认无编辑入口。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L8) · [共享定义断言](../apps/admin-web/test/settings.test.tsx#L273) | `PASS` · 实际矩阵查找读权限、按角色过滤且只读，五角色值符合共享 RBAC。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3123) |
| CMP-38 | 从独立设备用户页打开详情，核对账号、分配历史、通知投递、Sync 确认和实际应用状态。越权角色看不到写入口。 | `PASS_LOCAL` [状态分区](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L61) · [客户只读](../apps/admin-web/e2e/admin-web.spec.ts#L42) | `PASS` · 真实设备首次 Sync 获得专用账号，第二次带已提供快照时间读回 ACKNOWLEDGED。可区分通知与快照确认；无可信应用回执，仍显示未报告。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3145) |
| CMP-39 | 修改设备用户资料，试空原因与请求失败。取消返回且不改写，成功写入带版本与原因并回读。 | `PASS_LOCAL` [失败可退、读回及 If-Match](../apps/admin-web/test/device-users.test.tsx#L284) | `PASS` · 页面请求中止时仍可取消，重开读回原值和版本。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3234) |
| CMP-40 | 用平台和客户角色查看站点筛选，检查客户、区域、子区域、状态和独立新建操作。核对既有查询行为与固定客户范围。 | `PASS_LOCAL` [站点筛选布局和请求](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L121) · [站点服务范围](../apps/cloud-api/test/admin-site.test.ts) | `PASS` · 平台的客户、地区筛选命中真实长站点，独立新建入口可见，详情展示完整文本，客户越权读取被拒。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3273) |
| CMP-41 | 在列表滚动后打开某站点详情。失败可重试，Esc 关闭恢复同一行焦点与滚动。按角色验编辑、停用及其版本。 | `PASS_LOCAL` [小视口、焦点与版本](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L126) | `PASS` · 筛选完成后再记录真实滚动，资料连接失败后重试并恢复原行与滚动。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3312) |
| CMP-42 | 以五种角色核对用户管理、独立设备用户入口和直达路径。打开用户管理时检查后台请求，设备用户列表只在进入主页面后加载。 | `PASS_LOCAL` [角色矩阵及请求计数](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) | `PASS` · 实际设备用户直达与权限匹配，获准设置入口在跳转前未请求设备用户列表。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3369) |
| CMP-43 | 审计日志用长操作人或对象 ID 叠加动作、结果和时间。可操作查询与重置，参数按可见权限和显示时区生效。 | `PASS_LOCAL` [双语筛选](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L124) · [筛选与权限](../apps/admin-web/test/audit-logs.test.tsx#L82) | `PASS` · 审计员在中英文窄屏从真实第二页重置。可编辑客户、筛选字段、日期错误、累积结果和游标均清理，页面重新获取第一页。两个客户会话的 API 返回 403，客户管理员直达也被路由权限拒绝。 [修复回执](audit/evidence/cmp-t12-353d2deb/target-reset-follow-up-d1afec5e.json#L1633) |
| CMP-44 | 查看含长 JSON 的审计详情。前后值可独立滚动，敏感字段脱敏。关闭按钮及 Esc 可退出，Tab 留在当前对话框并恢复焦点。 | `PASS_LOCAL` [浏览器焦点与长 JSON](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L138) · [服务端脱敏](../apps/cloud-api/test/admin-audit.test.ts#L286) | `PASS` · 真实审计响应及浏览器均遮蔽受控敏感值。真实长值、键盘和焦点通过，前后值独立双向滚动使用已脱敏的界面投影。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3518) |

## 3. 共享测试环境已发布与验收结果

按用户批准将 `main` 从 [`97cdd503`](https://github.com/inrust/food-digester-platform/commit/97cdd503db32f350a4f1d283b70200c817bbf8c1) 非强制快进至 [`fc1793dc`](https://github.com/inrust/food-digester-platform/commit/fc1793dca6359d5dc16d7f8c6e8e84fcf8520dc5)。先确认前端、管理 API、OpenAPI 与媒体索引迁移使用同一 SHA，P1 首轮结束后再开展其余项目。实测使用五个独立 Cognito 账号、两组专用租户和各自站点及模拟设备。浏览器覆盖中文、英文和 375、768、1366、1440 像素等已记录视口。每项保留角色、请求 ID、执行顺序和重跑结果。 [目标实测回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json)

| 检查项 | 已核对结果 |
| --- | --- |
| 本地完整验证 | 修复候选完整 `pnpm verify` 退出 0。原候选的五项脚本失败仍保留。 [本地追验](audit/evidence/cmp-t12-353d2deb/target-preflight.json) |
| 托管完整验证 | 同一 SHA 的独立 CI 和共享测试部署的 `pnpm verify` 均通过，CDK 成功部署测试栈。 [独立 CI](https://github.com/inrust/food-digester-platform/actions/runs/44466828941) · [API 部署](https://github.com/inrust/food-digester-platform/actions/runs/44466828832) |
| 活动前端与 API | Amplify `main` 活动任务 170 成功。CloudFormation 测试管理 API Lambda 的代码哈希与 S3 固定版本的完整对象 SHA-256 一致。 [目标实测回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json) |
| API 契约 | OpenAPI Bundle 版本 `0.2.0`，SHA-256 `5d1e026ddd90ddeda495c61c730de7e8a21c65178abe8434e2c7b9a3c17f0e73`。实测从真实 API 读取账号资料和按设备生效配置，另保留媒体列表的实际契约失败。 [目标实测回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json) |
| 固定迁移 | 现有测试 Migration Runner 构建 `20717085-13e9-49a3-9d47-9702f4644ca3` 成功，读回 45 条迁移已完成、未完成 0。实际运行包包含与完整候选归档逐字节一致的 144 个 Runner 文件，固定版本与哈希见回执。 [迁移及版本证据](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json) |

44 项逐项结论为 10 项 PASS、1 项 FAIL、33 项 NOT_RUN，其中 31 项有部分实测记录。P1 为 5 项 PASS、0 项 FAIL、10 项 NOT_RUN，其中 9 项有部分实测记录。部分覆盖项仍以 `NOT_RUN` 标记其整条验收，具体已通过的断言和缺口保留在对应回执。首轮失败及其重测全部保留。项目方可按上一节的复现步骤和逐项回执继续走查。

### CMP-23 修复复验

原候选请求 `31d18d9d-73b7-4c28-96e5-d03ae2c40ea3` 对应的 Lambda 调用已通过认证和账号查询。媒体列表的原始查询经过实时预览的权威写入包装器时丢失 Prisma 方法接收者，三种列表模式均在媒体 SQL 发出前异常。修复让事务内外的查询保留方法所属对象，原有排序、租户范围、版本和下载契约继续生效。用本机合成数据复现修复前异常，并复验同一个包装器。 [修复回执](audit/evidence/cmp-t12-353d2deb/target-cmp23-follow-up-07a385f4.json)

候选 [`07a385f4`](https://github.com/inrust/food-digester-platform/commit/07a385f4a1193e70334b9438914b0e1e2d9cca76) 的 `pnpm verify` 和测试部署通过。Amplify 活动构建 171、管理 API Lambda 的固定 S3 产物、OpenAPI Bundle 和 Migration Runner `fdp-test-migration-runner:27012522-f744-49fb-a5f7-7da0f621c585` 均绑定该 SHA。数据库迁移文件字节无变化，Runner 读回 45 条已完成、0 条未完成。 请求、分页和隔离均见新候选回执。下载权限、15 分钟有效期及过期拒绝均实测。 [共享测试部署](https://github.com/inrust/food-digester-platform/actions/runs/44478308608) · [修复回执](audit/evidence/cmp-t12-353d2deb/target-cmp23-follow-up-07a385f4.json)

### `07a385f4` T12 补验

复验前后均核对活动前端构建 171、管理 API 工件、OpenAPI 和 Migration Runner 使用同一候选。P1 缺口先执行，随后复验其余待测项，并保留失败断言和针对已确认问题的重跑。专用业务用户已登录、完成实际权限写入并读回审计，随后恢复 CustomerViewer。CMP-23 的同 SHA 通过证据单独保存。 [本轮逐项回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json) · [CMP-23 同 SHA 回执](audit/evidence/cmp-t12-353d2deb/target-cmp23-follow-up-07a385f4.json)

累计 38 项 PASS、2 项 FAIL、4 项 NOT_RUN，通过项均有 `07a385f4` 同 SHA 证据。P1 累计 15 项 PASS、0 项 FAIL、0 项 NOT_RUN。CMP-33 首轮使用错误的 `If-Match` 头，实际同值保存使全局配置版本增加一次，审计确认阈值未变。复验改用契约的请求体 `version`，真实返回 409，关闭与读回均正常。CMP-21 已从告警详情验证图片和跨租户拒绝。CMP-44 的目标接口脱敏、真实长值和候选前端双区滚动均已验证，嵌套敏感键由本地回归覆盖。旧回执的 CMP-07 和 CMP-09 编号按开发计划校正至本轮目标索引，原始记录保留。 [本轮逐项回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json)

### `d1afec5e` 筛选重置复验

中英文 375 像素下复验告警三标签及审计日志。采用两组受控租户和真实 API 游标。对与本次改动相邻的 CMP-23 另跑媒体旧客户端、同采集时间双向分页和租户边界冒烟，原 `07a385f4` 的完整通过回执继续保留。未重跑的验收项在索引注明原证据 SHA。 [本轮逐项回执](audit/evidence/cmp-t12-353d2deb/target-reset-follow-up-d1afec5e.json) · [CMP-23 完整历史回执](audit/evidence/cmp-t12-353d2deb/target-cmp23-follow-up-07a385f4.json)

### `d1afec5e` 剩余样本补验

共享测试前后两次读回均为候选前端 172、管理 API、契约和 Migration Runner。CMP-07 离线与在线权限组合、CMP-10 的证书及分配历史空态均通过真实接口和浏览器验证。其余结果区分真实回包、候选浏览器合成响应和本地回归。已通过的 40 项原结论及已有失败历史继续保留。 [补验回执](audit/evidence/cmp-t12-353d2deb/target-sample-follow-up-d1afec5e.json) · [重置与媒体续验](audit/evidence/cmp-t12-353d2deb/target-reset-follow-up-d1afec5e.json)

### `d1afec5e` 真实零台补验

获批后新增专用空租户 C 和一个抑制通知的只读测试账号。平台以租户筛选读到零台，客户会话读取概览和设备列表也为零。中英文 375 像素均可从概览用键盘进入设备列表，搜索另一租户的已知测试设备仍为空。API 拒绝两组异租户筛选及异租户设备直达。前后版本均绑定 `d1afec5e`。 [真实零台回执](audit/evidence/cmp-t12-353d2deb/target-signoff-d1afec5e.json#L344)

## 4. 发布待办与回退版本

| 状态 | 待办与放行条件 |
| --- | --- |
| `RESOLVED` · CMP-23 | 原候选九个有效请求的 HTTP 500 历史保留。修复候选目标复验为 `PASS`。目标数据库查询计划为 `NOT_RUN`。 [修复回执](audit/evidence/cmp-t12-353d2deb/target-cmp23-follow-up-07a385f4.json) |
| `RESOLVED` · CMP-20 | 告警、事件和防拆分别在中英文窄屏验证真实第二页。独立重置清除草稿、已应用条件、游标和 URL 筛选，保留当前标签及固定客户范围。默认查询在第二页原地重置也回到第一项。两租户的可见范围已逐接口读回。 [修复回执](audit/evidence/cmp-t12-353d2deb/target-reset-follow-up-d1afec5e.json#L1420) |
| `RESOLVED` · CMP-43 | 审计员在中英文窄屏从真实第二页重置。可编辑客户、筛选字段、日期错误、累积结果和游标均清理，页面重新获取第一页。两个客户会话的 API 返回 403，客户管理员直达也被路由权限拒绝。 [修复回执](audit/evidence/cmp-t12-353d2deb/target-reset-follow-up-d1afec5e.json#L1633) |
| `RESOLVED` · CMP-21、CMP-44 | 告警图片从详情读回并验证签发及隔离。审计脱敏由真实 API 和浏览器确认，前后值滚动用界面投影覆盖，嵌套键由本地回归覆盖。 [告警回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L1645) · [审计回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3518) |
| `RESOLVED` · CMP-36 | 专用业务用户角色嵌套确认、实际写入和审计读回通过，角色已恢复为只读。 [本轮回执](audit/evidence/cmp-t12-353d2deb/target-completion-07a385f4.json#L3043) |
| `RESOLVED` · CMP-07、CMP-10 | 真实设备状态和授权组合、证书及空分配历史已补测。 [快捷操作](audit/evidence/cmp-t12-353d2deb/target-sample-follow-up-d1afec5e.json#L974) · [设备详情](audit/evidence/cmp-t12-353d2deb/target-sample-follow-up-d1afec5e.json#L1005) |
| `RESOLVED` · CMP-02 真实零台 | 专用空租户 C 的真实接口、双语概览、列表和租户隔离均通过。 [零台实测](audit/evidence/cmp-t12-353d2deb/target-signoff-d1afec5e.json#L344) |
| `NOT_RUN` · CMP-34 后续全链路 | 接入可信耗材采集后，在获准的测试设置下读回真实剩余量与自定义阈值，再验证 FE-18 分档与设置恢复。 本次合成分档范围已确认签收。 [后续验收范围](audit/evidence/cmp-t12-353d2deb/target-signoff-d1afec5e.json#L703) |
| `OPEN` · D5 可信回执 | 两台专用同型号模拟设备与真实 mTLS Sync 均验证了云端生效版本。缺少匹配的可信应用回执时，设备实际应用版本按契约显示未知。当前样本的设备侧实际应用仍为未知。 |
| `PASS` · 本次验收范围 | 记录本次会话的签收范围。项目方具名签字及归档待登记。 [签收记录](audit/evidence/cmp-t12-353d2deb/target-signoff-d1afec5e.json) |

共享测试当前候选为 [`d1afec5e`](https://github.com/inrust/food-digester-platform/commit/d1afec5ec12ad78a3aeb0bccb864b6f25e3439f8)。本修复的直接回退版本是 [`07a385f4`](https://github.com/inrust/food-digester-platform/commit/07a385f4a1193e70334b9438914b0e1e2d9cca76)，其前端和管理 API 应成对回退，届时将恢复两处重置缺口。整体项目回退仍可参考 [`97cdd503`](https://github.com/inrust/food-digester-platform/commit/97cdd503db32f350a4f1d283b70200c817bbf8c1) 的历史配套产物。已增加的普通索引可保留，本轮回退演练为 `NOT_RUN`。

| 失败范围 | 可回退的源码版本 | 回退注意点 |
| --- | --- | --- |
| 整体候选或工作包 A | [`97cdd503`](https://github.com/inrust/food-digester-platform/commit/97cdd503db32f350a4f1d283b70200c817bbf8c1) | 前端与管理 API 成对回退。先查目标现存版本、对应构建产物和迁移状态。 |
| 工作包 B 布局与详情 | [`a04640be`](https://github.com/inrust/food-digester-platform/commit/a04640becc25c8e22341fd203c973e0c6865cc45)（T04 后） | 保留工作包 A。后续批次随该版本整体退回。 |
| CMP-23 媒体接口或排序 | [`75497720`](https://github.com/inrust/food-digester-platform/commit/7549772076d208e55783015958d48a7ae31784b3)（T07 后） | 原候选 `fc1793dc` 的旧默认也返回 500。修复管理 API 或按配套候选同步回退，再从首页获取旧 ID 游标。已加的普通索引可保留。 |
| 工作包 D 顶栏和导航决定 | [`243734b8`](https://github.com/inrust/food-digester-platform/commit/243734b82ab1c3c4a505c06989fe4f54ba563475)（T08 后） | 保留媒体兼容契约。T10、T11 随 T09 成对回退。 |
| CMP-16/17 配置发布与展示 | [`dacaf73b`](https://github.com/inrust/food-digester-platform/commit/dacaf73b35be12a210f354ab8a656a96351fa312)（T09 后） | 核对业务记录和已有配置版本，匹配前端与 API 版本。 |
| CMP-01/02 账号与概览 | [`e6f8762b`](https://github.com/inrust/food-digester-platform/commit/e6f8762be9ff560b8c06938ae06917f4fc0644c3)（T10 后） | 保留 T10。按已留存的同版本构建与 API 产物回退。 |

分批回退的源码点已核对。其目标环境回退演练为 `NOT_RUN`，执行前须确认对应已验证的发布产物。历史主分支部署记录仅用于回退参考。

## 5. T12 签收记录

| 项目 | 签收记录 |
| --- | --- |
| 候选与环境 | `d1afec5e`，共享测试，前端构建 172。API、OpenAPI、Migration Runner 和托管验证见同 SHA 回执。 |
| 范围与日期 | 本次会话书面确认，2026-11-19（Asia/Shanghai）。44 项均符合本次约定范围，既有通过项保留各自证据 SHA。 |
| CMP-02 | 真实空租户的概览、列表和租户隔离通过。 |
| CMP-34 | 合成读数分档按本次确认范围通过。真实采集、投影及实际自定义阈值全链路列为后续，状态 `NOT_RUN`。 |
| 归档 | 项目方具名签字待登记。目标库查询计划、回退演练以及 D5 可信设备回执沿用本材料中的状态。 |

[签收及逐项回执](audit/evidence/cmp-t12-353d2deb/target-signoff-d1afec5e.json) · [剩余样本补验原回执](audit/evidence/cmp-t12-353d2deb/target-sample-follow-up-d1afec5e.json)
