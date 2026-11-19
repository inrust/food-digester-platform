# CMP 管理后台候选版本验收与项目方走查

2026-11-19 · 工作包 E / T12

| 项目 | 当前结论 |
| --- | --- |
| 验收候选 | [`fc1793dc`](https://github.com/inrust/food-digester-platform/commit/fc1793dca6359d5dc16d7f8c6e8e84fcf8520dc5)。原候选 `353d2deb` 与修复候选共有 T01–T11 历史。远端 `main` 已从 `97cdd503` 快进。 |
| 本地回归 | 管理后台与 Cloud API 类型检查通过。Vitest 67 个文件、742 项通过。Playwright Chromium 73 项通过。契约测试 321 项通过。OpenAPI、136 条 REST 路由一致性、模块边界、数据库迁移结构及管理后台交付检查通过。QA08 全量原型回归 24 项和 24 份 DOM 快照通过。 |
| 完整验证追验 | 候选 `353d2deb` 的完整 `pnpm verify` 在 `test:scripts` 失败。仅修改验收脚本的修复候选 [`fc1793dc`](https://github.com/inrust/food-digester-platform/commit/fc1793dca6359d5dc16d7f8c6e8e84fcf8520dc5) 完整 `pnpm verify` 通过。 [追验回执](audit/evidence/cmp-t12-353d2deb/target-preflight.json) |
| 目标环境 | 共享测试环境四项版本证据已对齐。44 项验收索引为 10 项 PASS、1 项 FAIL、33 项 NOT_RUN，其中 31 项有部分实测记录。P1 首批为 5 项 PASS、0 项 FAIL、10 项 NOT_RUN，其中 9 项有部分实测记录。 [目标实测回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json) |
| 发布结论 | `BLOCKED`。CMP-23 的媒体列表在共享测试环境对升序、降序和旧客户端均返回 500。项目方签收 `OPEN`。 [复现和请求 ID](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json) |

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
| CMP-01 | 用长显示名账号登录。确认顶部截断。用 Enter 打开账号详情，核对完整名称、业务 ID、Cognito 用户名和 sub，按 Esc 回到入口。无业务名称的账号依次回退到已验证邮箱或用户名。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-account-dashboard.spec.ts#L7) · [本人资料和越权参数](../apps/cloud-api/test/admin-user.test.ts#L329) | `NOT_RUN` · 部分实测 · 平台和客户账号的只读名称、全文、登录标识与键盘入口已实测。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L370) |
| CMP-02 | 用平台和客户账号打开概览。分别用 0、2、13 台数据看总数与预览，最多显示 10 台并保持 ID 升序。打开设备列表，客户账号保持本客户范围。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-account-dashboard.spec.ts) · [服务端范围和顺序](../apps/cloud-api/test/admin-dashboard.test.ts#L396) | `NOT_RUN` · 部分实测 · 平台和两类客户概览已核对设备预览上限、ID 顺序及租户范围。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L415) |
| CMP-03 | 登录后检查顶部，通知铃铛与徽标隐藏。用有权限角色从现有菜单进入告警页。 | `PASS_LOCAL` [壳层断言](../apps/admin-web/test/shell.test.tsx#L130) · [五角色浏览器](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) | `PASS` · 五种角色的实际顶部栏不展示通知铃。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L497) |
| CMP-04 | 以旧 London/纽约偏好打开页面，回退到上海。切换上海与 UTC，核对同一时间在媒体页的显示，重新登录核对默认上海。 | `PASS_LOCAL` [五角色时区](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) · [登录和重置](../apps/admin-web/e2e/qa05-workflows.spec.ts#L129) | `PASS` · 五角色只见上海与 UTC，伦敦和纽约旧偏好回退上海，切换后刷新可读回。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L557) |
| CMP-05 | 在查看设备页从授权列表分别选择有区域标签、缺标签及无站点设备。选中前应用禁用，选中后可查询。失败可重试。客户账号仅见本客户可用设备。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-device-query.spec.ts#L6) · [无站点路径](../apps/admin-web/test/device-view.test.tsx#L142) | `NOT_RUN` · 部分实测 · 客户按地区和站点查询，平台可不经地区选中专用无地区标签设备。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L617) |
| CMP-06 | 操作设备先查询 A，再把选择改成 B。确认 B 前禁发命令，延迟 A 响应后仍以完成查询的 B 为目标。核对请求路径中的设备 ID。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-device-query.spec.ts#L71) | `NOT_RUN` · 部分实测 · 选择草稿不改变 A 已应用目标，查询后命令真实请求仅发送到确认的纯模拟器 B。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L726) |
| CMP-07 | 打开操作设备的快捷操作，逐分类检查动作。禁用动作可读到原因。高风险动作复验确认及设备状态限制。 | `PASS_LOCAL` [快捷操作分组](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L145) · [命令门控](../apps/admin-web/test/device-operate.test.tsx#L223) | `NOT_RUN` · 部分实测 · 中英文实际查询带长关键字，单一重置清关键字和游标。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L881) |
| CMP-08 | 在窄屏切换中英文，选择长命令名并应用命令状态筛选。下拉与筛选按钮均可达，实际过滤值正确。 | `PASS_LOCAL` [双语重叠回归](../apps/admin-web/e2e/cmp-device-query.spec.ts#L162) | `PASS` · 中英文 375、768、1440 像素下无重叠，实际请求带所选命令。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L915) |
| CMP-09 | 设备群叠加站点、关键字和状态，翻页后执行单一重置。回到第一页，清空可编辑条件并保留固定客户范围。 | `PASS_LOCAL` [筛选、游标和重置](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L163) | `NOT_RUN` · 部分实测 · 真实快捷操作按类别显示，无目标时有禁用原因。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L945) |
| CMP-10 | 从设备群打开设备详情，按区检查四轴状态、生命周期、配置、OTA、备注、证书和分配历史。审计角色入口按权限呈现。 | `PASS_LOCAL` [设备详情与权限](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L210) · [长值](../apps/admin-web/e2e/admin-web.spec.ts#L1287) | `NOT_RUN` · 部分实测 · 设备管理详情分区和分配记录的目标观察见回执。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L968) |
| CMP-11 | 点待审批记录即打开弹窗，依次检查加载、失败、重试与详情。快速切换记录或标签，关闭后等迟到响应，旧详情保持关闭。审批确认可独立退出。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/admin-web.spec.ts#L226) · [迟到响应](../apps/admin-web/test/onboarding.test.tsx#L165) | `NOT_RUN` · 部分实测 · 两条授权待审批记录可分别打开，嵌套取消、切标签后零写。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1080) |
| CMP-12 | 拒绝待审批记录，核对原因与版本。失败留在详情并可重试。成功关闭并从待审批移除，切换已拒绝标签核对新状态。另验批准后的跳转。 | `PASS_LOCAL` [拒绝读回](../apps/admin-web/e2e/admin-web.spec.ts#L226) · [原因、版本和批准](../apps/admin-web/test/onboarding.test.tsx#L138) | `PASS` · 真实拒绝成功与版本读回，另以本机中止连接实测保留详情、显示重试及取消确认。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1219) |
| CMP-13 | 打开配置列表，在中英文窄窗口确认有权限时「新建配置」在工具栏最左侧，查询和重置成组。 | `PASS_LOCAL` [工具栏位置](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L131) | `PASS` · 真实配置工具栏首位为新建配置，键盘退出恢复焦点。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1364) |
| CMP-14 | 从列表打开配置详情，核对摘要、目标、派生上下文和版本历史。用加载失败与空方案检查提示和重试。 | `PASS_LOCAL` [详情与空、错状态](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L8) | `NOT_RUN` · 部分实测 · 真实自有配置摘要与三份版本可分别展开和查看。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1384) |
| CMP-15 | 打开多版本方案，确认历史按需展开、高度受限。键盘可到达早期版本并查看只读参数和投递状态。 | `PASS_LOCAL` [24 版本及键盘](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L8) | `NOT_RUN` · 部分实测 · 窄屏的历史版本可键盘访问，审计员写操作禁用。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1426) |
| CMP-16 | 发布草稿。上海录入凌晨及 UTC 录入同一钟点，核对实际 UTC 请求。试非法输入、修正后提交及留空发布，检查原因保留。 | `PASS_LOCAL` [三种真实浏览器输入](../apps/admin-web/e2e/cmp-configuration-effective.spec.ts#L175) | `NOT_RUN` · 部分实测 · 真实上海次日凌晨转前一 UTC 日，发布即生效和未来版本读回。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1468) |
| CMP-17 | 查同型号多台设备、设备定向覆盖、未来版本和无配置。翻页并对照 Sync 解析。分别查两版投递，缺可信应用回执的设备显示「未知」。 | `PASS_LOCAL` [分页 UI 与投递](../apps/admin-web/e2e/cmp-configuration-effective.spec.ts#L31) · [解析与权限](../apps/cloud-api/test/admin-configuration.test.ts#L465) | `NOT_RUN` · 部分实测 · 自有设备的 DEVICE 当前版本、未来版本、逐版本通知和未知反馈已读回。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1565) |
| CMP-18 | 在耗材状态和申请区填设备、站点或余量，检查标签、动作和实际查询参数，窄屏双语可读。 | `PASS_LOCAL` [双语和查询](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L55) | `NOT_RUN` · 部分实测 · 耗材和申请两个表按长值查实际 API，中英文三种视口已核对。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1628) |
| CMP-19 | 新建耗材申请从有权设备中选择。选中后模拟失效，应在设备字段旁报错。分别验不存在、未分配、已退役、越权、合法和重复申请。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-consumable-esg.spec.ts#L5) · [服务端拒绝和幂等](../apps/cloud-api/test/admin-consumable-request.test.ts#L206) | `NOT_RUN` · 部分实测 · 操作员浏览器成功提交专用设备，幂等读回，服务端拒绝不存在或无权设备。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1662) |
| CMP-20 | 逐个切换告警、事件和防拆，确认可见条件与实际 endpoint 一致，长筛选值下仍能查询与重置。 | `PASS_LOCAL` [三标签查询](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L79) | `NOT_RUN` · 部分实测 · 中英文告警、事件、防拆请求走各自真实 endpoint 及字段。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1809) |
| CMP-21 | 打开已清除及待处理告警，核对状态、发生/清除时间和原因。检查证据图片入口与确认/清除权限。 | `PASS_LOCAL` [详情布局与只读门控](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L210) · [证据图片](../apps/admin-web/e2e/evidence-image.spec.ts) | `NOT_RUN` · 部分实测 · 自有模拟告警真实送达，详情显示严重级别并可由审计员读取。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L1922) |
| CMP-22 | 用平台与客户角色打开媒体，验证设备、客户、类型、状态和日期控件权限及窄屏可读性。按键执行查询并核对条件。 | `PASS_LOCAL` [媒体筛选](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L105) · [媒体组件和传输](../apps/admin-web/test/media.test.tsx) | `NOT_RUN` · 部分实测 · 平台媒体筛选以实际请求传递长值和客户，三种视口布局已核对。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2017) |
| CMP-23 | 用多个同采集时间文件检查正倒序相邻两页，无重复遗漏。切换排序或筛选回首页，错误游标被拒绝，旧客户端和下载继续可用。 | `PASS_LOCAL` [换向和迟到响应](../apps/admin-web/e2e/cmp-media-capture-sort.spec.ts#L25) · [双向游标、旧客户端与租户](../apps/cloud-api/test/media.test.ts#L591) | `FAIL` · `BLOCKED` · 三个角色、两组自有租户的升序、降序和旧默认请求全部 HTTP 500。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2051) |
| CMP-24 | ESG 概览切统计粒度、客户及日期并应用。核对查询范围、时区、估算说明与导出入口。 | `PASS_LOCAL` [筛选栏](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L113) · [导出与时区](../apps/admin-web/e2e/qa05-workflows.spec.ts#L197) | `NOT_RUN` · 部分实测 · 中英文 ESG 粒度和客户组合发出实际汇总请求。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2110) |
| CMP-25 | 设备 ESG 分别在已应用、分页和日期错误状态重置。立即导出，再重新查询，核对日期、设备、游标被清除且保留固定客户范围。 | `PASS_LOCAL` [查询与导出请求](../apps/admin-web/e2e/cmp-consumable-esg.spec.ts#L81) | `NOT_RUN` · 部分实测 · 日期查询及错误重置后清过滤和游标，实际导出保留固定客户。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2175) |
| CMP-26 | 合约列表选择长客户名，在小视口用筛选按钮。检查按钮和下拉可独立操作，所选客户能进入查询参数。 | `PASS_LOCAL` [双语重叠回归](../apps/admin-web/e2e/cmp-device-query.spec.ts#L162) | `PASS` · 中英文 375、768、1440 像素下无重叠，实际请求携所选客户。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2239) |
| CMP-27 | 打开合约详情，检查摘要、期限、许可的联系人字段、关联设备与记录。再走编辑、续约、关联和解绑，核对 License 的独立状态。 | `PASS_LOCAL` [详情和门控](../apps/admin-web/test/contracts.test.tsx#L346) · [浏览器写入与读回](../apps/admin-web/e2e/admin-web.spec.ts#L1053) | `NOT_RUN` · 部分实测 · 合约期限、联系人区、关联及三个入口已读回。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2318) |
| CMP-28 | 合约详情打开关联设备。在加载、无候选和提交错误态退出，焦点返回原按钮，没有额外写入。迟到请求不会填入新弹窗。 | `PASS_LOCAL` [加载与空候选](../apps/admin-web/test/contracts.test.tsx#L485) · [浏览器零写](../apps/admin-web/e2e/admin-web.spec.ts#L1189) | `NOT_RUN` · 部分实测 · 实际关联对话框可见关闭、零写和焦点返回。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2360) |
| CMP-29 | 合约编辑改名后分别关掉、取消。检查零写、焦点和重开后的保存值，再用原因和版本走合法保存。 | `PASS_LOCAL` [关闭、取消与读回](../apps/admin-web/e2e/admin-web.spec.ts#L1181) · [并发版本](../apps/admin-web/test/contracts.test.tsx#L397) | `PASS` · 编辑取消与关闭均零写、重开读回，实际保存携原因及版本并生效。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2402) |
| CMP-30 | 续约录无效时间或空原因后取消，核对零写和入口焦点。重开输入合法时间与原因，检查版本更新和保存反馈。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/admin-web.spec.ts#L1207) · [续约门控](../apps/admin-web/test/contracts.test.tsx#L415) | `PASS` · 无效日期禁止续约，关闭与取消零写，实际续约携原因和版本并读回。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2534) |
| CMP-31 | 用五种角色检查「授权管理」菜单和直达路径。获授权角色可跨设备查询和按权限写入，审计角色只读。 | `PASS_LOCAL` [角色路由与按钮](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) · [授权服务与审计](../apps/cloud-api/test/admin-license.test.ts) | `NOT_RUN` · 部分实测 · 五角色侧栏、直达和服务端授权范围已核对。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2669) |
| CMP-32 | 在独立 License 详情核对设备、有效期、Entitlement、状态历史与操作区。试无权限角色、到期记录与写入后的读回。 | `PASS_LOCAL` [License 详情与权限](../apps/admin-web/test/licenses.test.tsx) | `NOT_RUN` · 部分实测 · 审计员独立查看实际 License、设备和历史。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2806) |
| CMP-33 | 在业务设置编辑输入无效 JSON 后取消。重开读回原值，零写。提交合法值携版本，冲突可刷新回源。 | `PASS_LOCAL` [取消、版本与冲突](../apps/admin-web/e2e/admin-web.spec.ts#L1035) · [后端冲突](../apps/cloud-api/test/admin-settings.test.ts#L159) | `NOT_RUN` · 部分实测 · 业务设置无效 JSON 禁止提交，取消、关闭和重开零写。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2861) |
| CMP-34 | 看四项设置的用途、消费方、运行时状态和可编辑性。核对耗材告警阈值、命令认证时间窗以及两个仅存储项。 | `PASS_LOCAL` [FE-18 消费范围](../apps/admin-web/e2e/cmp-settings-runtime.spec.ts#L5) · [BE-CMD-01 时间窗](../apps/cloud-api/test/admin-command.test.ts#L267) | `NOT_RUN` · 部分实测 · 真实 API 与页面显示四项用途、状态、消费方和可编辑性。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2897) |
| CMP-35 | 打开平台用户表格，检查长邮箱、显示名和客户 ID 的完整值查看方式，窄屏仍能访问操作列。 | `PASS_LOCAL` [长值和行内入口](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L8) | `NOT_RUN` · 缺少可供走查的专用平台业务用户长值记录。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2934) |
| CMP-36 | 改角色后打开二次确认。Esc 关闭最上层，取消或关闭原表单不写入，焦点回原行。重开读回原角色，再确认一次写入。 | `PASS_LOCAL` [嵌套焦点及零写](../apps/admin-web/e2e/admin-web.spec.ts#L994) · [角色服务权限](../apps/cloud-api/test/admin-user.test.ts) | `NOT_RUN` · 缺少可安全修改的专用平台业务用户记录。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2945) |
| CMP-37 | 打开只读权限矩阵，按模块和权限找角色。逐列对照共享角色授权，确认无编辑入口。 | `PASS_LOCAL` [浏览器](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L8) · [共享定义断言](../apps/admin-web/test/settings.test.tsx#L273) | `PASS` · 真实只读矩阵、权限查找、角色筛选及共享权限定义匹配。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2966) |
| CMP-38 | 从独立设备用户页打开详情，核对账号、分配历史、通知投递、Sync 确认和实际应用状态。越权角色看不到写入口。 | `PASS_LOCAL` [状态分区](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L61) · [客户只读](../apps/admin-web/e2e/admin-web.spec.ts#L42) | `NOT_RUN` · 部分实测 · 设备用户自有详情、分配与应用区域的目标结果见回执。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L2986) |
| CMP-39 | 修改设备用户资料，试空原因与请求失败。取消返回且不改写，成功写入带版本与原因并回读。 | `PASS_LOCAL` [失败可退、读回及 If-Match](../apps/admin-web/test/device-users.test.tsx#L284) | `NOT_RUN` · 部分实测 · 设备用户校验、取消、关闭、原值和真实保存版本读回。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L3117) |
| CMP-40 | 用平台和客户角色查看站点筛选，检查客户、区域、子区域、状态和独立新建操作。核对既有查询行为与固定客户范围。 | `PASS_LOCAL` [站点筛选布局和请求](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L121) · [站点服务范围](../apps/cloud-api/test/admin-site.test.ts) | `NOT_RUN` · 部分实测 · 客户访问自有站点成功，跨租户请求被拒且无新建入口。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L3253) |
| CMP-41 | 在列表滚动后打开某站点详情。失败可重试，Esc 关闭恢复同一行焦点与滚动。按角色验编辑、停用及其版本。 | `PASS_LOCAL` [小视口、焦点与版本](../apps/admin-web/e2e/cmp-detail-layout.spec.ts#L126) | `NOT_RUN` · 部分实测 · 客户窄屏从自有站点行键盘打开详情，Esc 返回焦点。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L3307) |
| CMP-42 | 以五种角色核对用户管理、独立设备用户入口和直达路径。打开用户管理时检查后台请求，设备用户列表只在进入主页面后加载。 | `PASS_LOCAL` [角色矩阵及请求计数](../apps/admin-web/e2e/qa05-workflows.spec.ts#L33) | `PASS` · 五角色直达和链接依共享权限，进入设置不预加载设备用户。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L3347) |
| CMP-43 | 审计日志用长操作人或对象 ID 叠加动作、结果和时间。可操作查询与重置，参数按可见权限和显示时区生效。 | `PASS_LOCAL` [双语筛选](../apps/admin-web/e2e/cmp-filter-layout.spec.ts#L124) · [筛选与权限](../apps/admin-web/test/audit-logs.test.tsx#L82) | `NOT_RUN` · 部分实测 · 审计员实际对象筛选仅返回专用对象。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L3415) |
| CMP-44 | 查看含长 JSON 的审计详情。前后值可独立滚动，敏感字段脱敏。关闭按钮及 Esc 可退出，Tab 留在当前对话框并恢复焦点。 | `PASS_LOCAL` [浏览器焦点与长 JSON](../apps/admin-web/e2e/cmp-business-detail-layout.spec.ts#L138) · [服务端脱敏](../apps/cloud-api/test/admin-audit.test.ts#L286) | `NOT_RUN` · 部分实测 · 窄屏真实审计详情可用 Enter、Tab、Esc 和可见关闭，焦点返回。 [目标回执](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json#L3454) |

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

## 4. 发布待办与回退版本

| 状态 | 待办与放行条件 |
| --- | --- |
| `BLOCKED` · CMP-23 | 在已绑定的共享测试环境，用三个角色和两组自有租户查询，既有默认、升序和降序的 9 个有效请求均为 HTTP 500 `INTERNAL_ERROR`，非法方向返回 400。定位管理端媒体列表的服务端错误，新候选重新绑定后复验正倒序同时间跨页、旧默认、游标、租户隔离、下载授权与过期。目标数据库查询计划仍为 `NOT_RUN`。 [复现矩阵和请求 ID](audit/evidence/cmp-t12-353d2deb/target-execution-fc1793dc.json) |
| `OPEN` · P1 目标走查 | 业务用户角色确认缺专用可写业务账号。按索引补齐设备、耗材、ESG、全局设置、审计等剩余组合路径后签收。测试账号经 Cognito 登录已核实。 |
| `OPEN` · D5 可信回执 | 真实配置 API 显示设备云端生效版本，缺少匹配的可信应用回执时显示未知。型号覆盖和设备 Sync 对照尚待补测。 |
| `OPEN` · 项目方签收 | 走查材料与脱敏证据已登记。签收、剩余目标验收和回退执行保留各自的结果。 |

本轮已部署的当前候选为 `fc1793dc`。最近一次已知成功部署的整体回退版本为 [`97cdd503`](https://github.com/inrust/food-digester-platform/commit/97cdd503db32f350a4f1d283b70200c817bbf8c1)，对应历史 Amplify 活动任务 169 与 [测试 API 部署作业](https://github.com/inrust/food-digester-platform/actions/runs/43667829780)。如需回退，前端和 API 应成对切换，已增加的普通索引可保留。本轮回退执行 `NOT_RUN`。

| 失败范围 | 可回退的源码版本 | 回退注意点 |
| --- | --- | --- |
| 整体候选或工作包 A | [`97cdd503`](https://github.com/inrust/food-digester-platform/commit/97cdd503db32f350a4f1d283b70200c817bbf8c1) | 前端与管理 API 成对回退。先查目标现存版本、对应构建产物和迁移状态。 |
| 工作包 B 布局与详情 | [`a04640be`](https://github.com/inrust/food-digester-platform/commit/a04640becc25c8e22341fd203c973e0c6865cc45)（T04 后） | 保留工作包 A。后续批次随该版本整体退回。 |
| CMP-23 媒体接口或排序 | [`75497720`](https://github.com/inrust/food-digester-platform/commit/7549772076d208e55783015958d48a7ae31784b3)（T07 后） | 共享测试的旧默认也返回 500。修复管理 API 或按配套候选同步回退，再从首页获取旧 ID 游标。已加的普通索引可保留。 |
| 工作包 D 顶栏和导航决定 | [`243734b8`](https://github.com/inrust/food-digester-platform/commit/243734b82ab1c3c4a505c06989fe4f54ba563475)（T08 后） | 保留媒体兼容契约。T10、T11 随 T09 成对回退。 |
| CMP-16/17 配置发布与展示 | [`dacaf73b`](https://github.com/inrust/food-digester-platform/commit/dacaf73b35be12a210f354ab8a656a96351fa312)（T09 后） | 核对业务记录和已有配置版本，匹配前端与 API 版本。 |
| CMP-01/02 账号与概览 | [`e6f8762b`](https://github.com/inrust/food-digester-platform/commit/e6f8762be9ff560b8c06938ae06917f4fc0644c3)（T10 后） | 保留 T10。按已留存的同版本构建与 API 产物回退。 |

分批回退的源码点已核对。其目标环境回退演练为 `NOT_RUN`，执行前须确认对应已验证的发布产物。历史主分支部署记录仅用于回退参考。
