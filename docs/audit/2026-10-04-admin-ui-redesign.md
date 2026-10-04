# 管理员后台 UI 重设计与回归验收

日期：2026-10-04。范围：`apps/admin-web` 全部现有管理员界面，以及共用组件、语言资源和浏览器测试。业务服务、API 契约、权限规则、数据库和部署配置不在此次改造范围内。

## 功能保留矩阵

按当前组合根、路由和页面源码逐项梳理。保留全部 22 个业务页面以及登录、403、404 状态；已有子页面入口关系保持一致。

| 模块 / 路由 | 保留的业务功能与边界 | 回归覆盖 |
| --- | --- | --- |
| 登录 `/login` | SRP、MFA、首次设置新密码、忘记/重置密码、错误分类、登出与会话恢复 | login-page、auth-flow、session、QA05 登录流程 |
| 总览 `/dashboard` | 六指标、数据基准与统计日、告警、最多十台设备、命令与 OTA 跳转 | dashboard、浏览器离线/授权门禁 |
| 设备群 `/devices/groups` | 查询、筛选、四轴状态、游标分页、详情入口、入网审批/拒绝与证书状态 | devices、onboarding、审批双击单提交 |
| 设备监测 `/devices/view` | 区域/站点/设备级联、传感器、耗材、告警、媒体、ESG | device-console、QA08 控件对应关系 |
| 设备操作 `/devices/operate` | 快捷命令、高危文本确认、参数、命令状态、发布失败、历史与媒体 | commands、QA05 命令全流程 |
| 设备详情 `/devices/manage` | 元数据、分配/解绑、挂起/恢复、退役/强制完成、证书轮换、配置与固件入口 | device-manage、API 错误与重复提交 |
| 耗材 `/consumables` | unknown/stale、阈值来源、联系人按需查询、申请与状态机 | consumables、FE-18 浏览器流程 |
| 告警 `/alarms` | 查询、筛选、详情、严重告警强调、确认、事件及篡改记录 | alarms、403/409、确认流程 |
| 媒体 `/media` | 查询、元数据、图片/录制视频预览、受控下载、短链接过期/重签、删除态 | media、QA05 过期/拒绝 |
| 配置 `/configurations` | 配置创建、版本、激活、详情、字段校验与权限限制 | configurations |
| 设备账号 `/device-users` | 查询、创建、设备分配、停用、受控密码重置与凭证边界 | device-users |
| ESG `/esg/overview`、`/esg/devices` | 日/周/月、汇总/设备数据、计算版本、游标、CSV/XLSX 导出及快照、过期下载 | esg、QA05 跨游标/导出一致性 |
| 合约 `/contracts`、`/contracts/new`、`/contracts/detail` | 查询/修改、两阶段草稿与设备绑定、详情、解绑、续约、终止 | contracts、FE-17 浏览器流程 |
| 授权 `/licenses` | 查询、详情、发放、续期/撤销，合约与 License 独立状态 | licenses、合约边界验证 |
| OTA `/ota/packages`、`/ota/campaigns` | 固件上传/校验、VERIFIED 门禁、灰度创建、暂停/恢复/取消、批次扩展与重试 | ota、QA05 固件/发布入口 |
| 账号及设置 `/settings` | 平台邀请、角色整体替换、Customer scope、停用/重置、设备账号标签、只读 RBAC 矩阵、四项业务设置与乐观锁 | settings、FE-16 403/409 与回源 |
| 客户 `/customers` | 查询、创建、编辑、停用及关联限制 | customers、浏览器 CRUD |
| 站点 `/sites` | 查询、创建、编辑、时区校验、停用及关联限制 | sites、浏览器 CRUD |
| 审计 `/audit-logs` | 只读查询、筛选、详情与敏感字段脱敏，零写入 | audit-logs、QA05 零写入 |
| 五角色和路由守卫 | 可见菜单、受限路由、403/404、Customer scope、安全返回路径 | router、shell、QA05 五角色矩阵 |

“内容审核”不是现有独立模块；实际审批对象为设备入网请求。媒体模块保留原有查询、预览、下载与访问控制，没有新增发布审核业务。RBAC 矩阵仍为只读，只分配已有角色。系统配置仍按原有封闭 key 集和版本机制执行。

## 设计与落地

- 视觉：青绿主色 `#087f73`，深色导航 `#132b35`，工作区 `#f3f6f9`，正文 `#213547`，次要文字 `#607184`；成功/警告/危险使用独立语义色。状态同时提供文字，四轴禁止合并。
- 字体：系统字体回退，正文 14px、表格/控件 13px、页面标题 26px、指标 32px；4/8/12/16/24/32px 间距；8–10px 组件圆角、16px 登录卡片圆角、低强度卡片阴影。
- 框架：208/224px 固定宽度侧边栏，72px 最小顶部栏，独立导航滚动。当前项高亮，合约/设备详情显示父项高亮。长用户名换行；顶部控件按可用宽度折行。
- 组件：引入 Ant Design 6.6.5，统一 ConfigProvider 主题与中英 locale；全页面按钮、文本/数字/密码输入、文本域迁移至兼容包装；共享 Table、Empty、Skeleton、Tag、Progress、表单 Modal 升级。
- 兼容：包装保留原生 HTML type、form submit、required、onChange 和 DOM ref。文件上传、复选/单选与 select 保留原生值/选项/键盘契约并统一视觉；不改写原有联动数据流。危险 ConfirmDialog 保留既有原因必填、安全初始焦点与确认契约，统一控件和样式。
- 反馈：保留 loading、空态、stale、请求错误、权限拒绝、409 回源、Toast 和操作禁用；表格保留旧数据刷新提示和 `aria-busy`，分页仍为游标模式。横向滚动限定于表格，分页操作固定在表格下方。
- 无障碍：跳转工作区链接、可见焦点、标签关联、装饰图标 aria-hidden、弹窗焦点陷阱/背景 inert/Escape/回收，以及减少动态效果偏好。
- 自适应：1366×768、1440×900、1920×1080 办公尺寸；保留 375/768px 抽屉及表格滚动。宽屏六列指标，普通桌面三列，窄屏两列/一列。

组件属性依据 [Ant Design Button 官方文档](https://ant.design/components/button/) 和安装包类型定义核对。原有表格浏览器测试改为定位新 `.table-scroll` 容器，继续验证横向可滚动及页面不溢出。

## 验证与证据

验证结果与浏览器版本由本目录的证据文件记录。浏览器接口使用明确 fixture，禁止意外外部请求；这是实际浏览器中的本地组合根回归，不是已部署 API 的联调凭证。

| 检查 | 最终结果 |
| --- | --- |
| 全仓 Vitest | 165 文件 / 1327 项通过 |
| 前端专门回归（含控件兼容契约） | 36 文件 / 348 项通过 |
| API/领域契约测试 | 301 项通过 |
| 仓库脚本测试 | 407 项通过 |
| 跨浏览器业务与 UI 回归 | 初次 Chromium、Chrome、Firefox 99/99 通过；追加实际 Edge 33/33 通过，共 132 项 |
| 办公尺寸 | 22 路由 × 3 尺寸 × 4 浏览器，全部无页面溢出/文字裁切；另保留原有 375/768/1440px 中英多路由验证 |
| TypeScript | 21 个 workspace 通过 |
| Lint / Prettier / diff check | 通过 |
| 交付组合根 / 敏感 sink / 模块边界 / Schema / Migration / 敏感信息扫描 | 通过 |
| 生产构建 | 通过；组件库导致 >500kB chunk 警告仍保留 |

实际版本：Chromium 151.0.7922.34、安装版 Chrome 152.0.7977.82、Playwright Firefox 153.0；追加实际 Edge 154.0.4258.53。并不将受控测试版本声明为所有渠道的最新版。

[机器可读证据](evidence/admin-ui-redesign-2026-10-04/verification.json) 保存逐测试结果、浏览器版本、全部前端源码文件 SHA-256 和源树摘要，供本地提交后核对。没有保存会话 Token 或原始业务请求。

[总览截图](evidence/admin-ui-redesign-2026-10-04/dashboard.png)、[设备群截图](evidence/admin-ui-redesign-2026-10-04/devices-groups.png)、[账号设置截图](evidence/admin-ui-redesign-2026-10-04/settings.png)、[客户截图](evidence/admin-ui-redesign-2026-10-04/customers.png)：1366×768 实际 Chromium 截图，数据为 QA08 fixture，非生产数据。截图已逐张复核。

验证过程发现并已关闭：长用户名裁切、原生控件替换后的 DOM ref 兼容问题、筛选区输入整行占用。原有横向滚动断言调整到真实的新滚动容器；新键盘断言修正为跳过禁用提交按钮。最终全套 99 项重跑通过。脚本测试首次因系统旧版 OpenSSL 生成弱签名证书失败；改用本机已安装 OpenSSL 3 后重新通过，没有降低 TLS 校验。

## Edge 可执行程序兼容性补验

2026-10-04：通过 Playwright `channel: msedge` 启动本机 `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`，运行时版本为 **154.0.4258.53**，完整业务与 UI 套件 **33/33 PASS**。不是以 Chromium 结果代替 Edge。

覆盖五角色与路由权限、登录/MFA/登出、账号/角色/Scope、审批与重复提交、客户/站点 CRUD、危险命令确认、合约/授权边界、耗材状态、ESG 游标/导出、媒体链接过期/拒绝和只读审计。22 个业务路由在 1366×768、1440×900、1920×1080 下通过布局、导航滚动、弹窗键盘焦点及中英切换检查；原有 375/768/1440px 响应式回归也通过。

[Edge 补验证据](evidence/admin-ui-redesign-2026-10-04/edge-verification.json) 保存实际可执行程序、运行时版本、33 项结果、配置摘要及源码核对信息。全部 132 个前端源码文件与 `4d40c21` 原验收摘要一致，没有修改 UI 或业务逻辑。原始 `verification.json` 保留首次测试时的 Edge `NOT RUN` 历史记录；当前 Edge 结论以补验证据为准。

[Edge 总览](evidence/admin-ui-redesign-2026-10-04/edge-dashboard.png)、[Edge 设备群](evidence/admin-ui-redesign-2026-10-04/edge-devices-groups.png)、[Edge 账号设置](evidence/admin-ui-redesign-2026-10-04/edge-settings.png)、[Edge 客户](evidence/admin-ui-redesign-2026-10-04/edge-customers.png)：实际 Edge 的 1366×768 截图，使用隔离 fixture 数据。截图已逐张复核。前端 TypeScript、测试配置 ESLint、Prettier 和 diff check 通过。

## 验收边界与人工体验复核

2026-10-04 后续更新：用户已推送 `cb5beaa`，并确认真实管理员参与使用、可用性 OK；独立查询确认 Amplify 实际部署该提交。真实环境补验结果、临时记录停用状态、旧 Token 撤销失败及剩余验收缺口见[目标环境验收阶段记录](2026-10-04-admin-ui-target-acceptance.md)。以下各项保留 UI/Edge 本地回归交付时的历史边界，不将后续有限验证扩展为全目标验收 PASS。

1. 实际 Edge 可执行程序兼容性已补测 **PASS（33/33）**。默认测试保持 Chromium；`UI_COMPAT_RUN=1 pnpm --filter @fdp/admin-web test:e2e` 可复跑 Chromium、安装版 Chrome、Playwright Firefox 和安装版 Edge；单独 Edge 使用 `UI_COMPAT_RUN=1 pnpm --filter @fdp/admin-web exec playwright test --project=edge`。
2. 未部署/未推送。真实 Cognito、真实管理员 API、生产数据、并发、跨 Customer 和已有目标环境验收凭证均未由本次 UI 回归补齐。
3. 已做布局和键盘交互检查及截图视觉复核；没有真实管理员参与的用户研究/可用性访谈，不能称为用户实测通过。
4. 正式交付前，管理员应在目标环境按上表执行核心流程，覆盖 1366×768 屏幕、真实长文本、多页/空结果、权限差异、导出文件、审批取消/提交及系统配置冲突。
5. 引入组件库增加首屏 JS，构建仍报告大于 500kB 的 chunk；未做目标办公网络性能测量。依赖版本由锁文件锁定，后续性能优化应单独验证，不能为压缩包体删减业务功能。
