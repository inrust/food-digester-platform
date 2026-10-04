# 管理后台真实目标环境验收：限定流程已执行，整体未通过

后续源码修复及本地回归见 [H-01/M-01 修复交付记录](2026-10-04-admin-ui-h01-m01-remediation.md)。本报告保留 `cb5beaa` 的真实失败证据；修复部署后复验尚未执行，目标环境结论不改为 PASS。

## 结论与版本

验收对象为 `cb5beaaeb50132045427c55542263c5f2e846496`。用户确认已推送该提交，并确认真实管理员参与使用、可用性 OK；记为 **人工可用性 PASS（用户确认）**。

本轮独立验证状态为 **FAIL / 会话撤销缺口及目标验收覆盖缺口**。用户确认创建临时账号后，已完成两个 Customer 角色的真实 SRP/API/浏览器登录、限定跨 Customer 与并发验证，并停用本轮全部自建记录。停用后旧 Token 仍被 API 接受，不能报告整体验收通过。初始阶段归档提交为 `234bf13`，初始 `incremental-verification.json` 保留历史状态；当前结论以 `completed-scoped-verification.json` 为准。以下证据均来自真实已部署服务或当前已登录浏览器，未使用 mock；普通本地回归与目标环境验收继续分别记录。

AWS 只读查询确认 `admin.bio-nexa.com` 为 `fdp-test-app` 的 AdminWebOrigin，账户 `065986019555`、区域 `ap-southeast-1`，环境标签 **test**。因此本轮为已有真实测试环境验收，不能仅因自定义域名而称作生产数据验收。

Amplify 应用 `d29sdr89i4zl0`、main 分支 job 50 为 SUCCEED，部署提交与验收提交完全一致。当前管理员 API Lambda 为 Active / Successful；其 CodeSha256 与历史 `b885e11` 已验证制品一致，且 `apps/cloud-api`、`packages`、`contracts/rest`、`infra` 的 Git tree 无变化。这支持 API 制品和相关源码的延续性核查；本轮 GitHub API 返回 404，未宣称当前提交的 CI 或后端部署流水线已独立复核成功。

## 控制点与实际结果

| 控制点 | 本轮结果 | 证据及限制 |
| --- | --- | --- |
| 人工可用性 | USER CONFIRMED PASS | 用户直接确认；不伪造访谈记录或自动化回执 |
| 前端实际部署版本 | PASS | Amplify job 50，完整 SHA 一致 |
| 真实 Cognito 配置 | PASS（配置及两个 Customer 角色登录） | 用户池 `ap-southeast-1_hZMX8LpFo`、客户端 `5ljdjsf9g563mc1vdc7vjdjm09`、SRP、五种角色存在，两个 Customer 角色均通过真实 SRP 和浏览器登录；其余角色覆盖仍不完整 |
| 已登录管理员业务读写 | PASS（限定流程） | 新建两个 Customer、两个 Site；页面持久化结果及四条真实审计 requestId |
| 未认证访问拒绝 | PASS | `/admin/customers`、`/admin/sites` 真实 API 均返回 401，保存网关 requestId |
| UI 重复提交保护 | PASS（限定一次） | Site B 保存双击，最终一个站点、一条 site.create 审计；未声称覆盖所有写接口 |
| If-Match 并发竞争 | PASS（限定自建设备用户） | 两个 PATCH 携带同一版本并发请求：200 / 409；读取版本只增加一次 |
| 跨 Customer 隔离 | PASS（限定 Site/DeviceUser） | 双向站点读取拒绝、列表/筛选不泄露另一 Customer、Viewer 对 A 的设备用户读取及写入拒绝；两浏览器各显示自己的站点 |
| 五角色目标登录 | PARTIAL | 已登录 SuperAdmin 被观察；CustomerAdmin/CustomerViewer 真实登录；Operator/Auditor 本轮未登录 |
| 全业务目标回归 | NOT RUN / 部分页面检查 | 多数列表为空，现有两台设备离线；没有执行终端命令、设备同步、OTA 成功、媒体短链到期、真实导出多页一致性等链路 |
| 中英文当前页面 | PASS（限定概览） | 实际 732×878 视口，中英文截图，无横向溢出；语言已恢复简体中文 |
| 目标桌面 1366×768 | UNVERIFIED | 请求视口覆盖后 DOM 仍为 732×878，截图按实际尺寸命名；覆盖已重置 |
| 四浏览器桌面兼容 | 历史本地 PASS | 原报告 132 项，隔离 fixture；不能替代本轮目标环境浏览器矩阵 |
| 生产数据 | NOT VERIFIED | 当前确认的基础设施环境为 test |
| 清理 | PASS（停用记录、删除私有凭证） | 两账号 DISABLED/Cognito Enabled=false；两个 Customer/Site SUSPENDED；一个设备用户 DISABLED；记录和审计保留，未永久删除 |
| 停用后旧 Token 拒绝 | FAIL | GlobalSignOut 后旧 ID Token 对两个自有 Site GET 仍返回 200；新登录拒绝 |

## 页面与数据检查

通过当前菜单及管理按钮检查概览、设备群、设备查看选择器、设备管理详情、设备操作、配置、耗材、告警、媒体、ESG 两页、合约列表/创建表单、授权、站点、客户、设备用户、用户管理、审计、OTA 固件包/Campaign 入口。

配置、告警、媒体、ESG、合约、授权和 OTA 列表正常加载为空。耗材对未上报值展示 unknown。概览两台设备均离线，快捷动作禁用并展示 DEVICE_OFFLINE。设备详情可显示证书摘要与暂无分配记录。合约创建表单展示必填校验且提交禁用；未提交、激活任何合约。审计筛选可定位本轮对象，详情可查看 requestId，Escape 可关闭详情。

这些结果只证明当前页面加载、有限数据展示和所述交互，不证明空数据下无法触发的业务流程。概览授权分布显示 `ACTIVE 2`，设备卡片授权轴显示 `—`，授权列表为空；暂记为需结合 API 数据进一步解释的观察，未无依据认定为 UI 缺陷。

## 临时测试数据与收尾状态

| 对象 | ID | 当前状态 |
| --- | --- | --- |
| UI-ACCEPT-20261004-Customer-A | `94371262-8afe-4fab-b748-2fb6d95c2bcd` | SUSPENDED |
| UI-ACCEPT-20261004-Customer-B | `54bcc341-d8c5-4624-b694-d0702282105d` | SUSPENDED |
| UI-ACCEPT-20261004-Site-A | `2c8bca29-c681-434c-8af7-3b0afe3e8a54` | SUSPENDED，属于 A |
| UI-ACCEPT-20261004-Site-B | `d8fa1d22-83ad-43d6-a01c-8c15715409a9` | SUSPENDED，属于 B |

用户已明确确认创建并在验收后停用两个账号。已通过真实管理员 UI 创建 `ui-accept-20261004-a@example.invalid`（CustomerAdmin，仅 A）和 `ui-accept-20261004-b@example.invalid`（CustomerViewer，仅 B）；用户 ID 分别为 `177af561-c07a-410c-a173-2748eb8b4bed`、`5ff0d880-2087-411c-807d-ab8c90abec48`。两个 `.invalid` 地址不能接收邮件；通过 Cognito 管理接口仅为这两个已验证绑定的新建测试账号设置随机凭证，使用应用 AuthFlow 的真实 SRP 登录，并在独立浏览器标签页登录验证。没有修改原有账号的凭证或权限。

限定 API 流程 30 次请求、41 项断言全部通过：两个角色自己的 Site 读取/列表正向通过；互访 Site 返回拒绝；跨 Customer 筛选无泄漏；用户管理/审计/业务设置拒绝；CustomerAdmin 创建自己的 DeviceUser；Viewer 对 A 的 DeviceUser 读取和修改拒绝；同版本并发 PATCH 恰好一 200、一 409；版本只增加一次；8 个并发认证读取一致。8 并发仅为有限突发，不是持续容量/SLO 测试。自建 DeviceUser `100fa4ca-44a5-4c22-ad04-133f685bcd16` 已停用，最终版本 3。

收尾核验另执行 4 个真实 API 请求，其中两个停用前的 DeviceUser 列表读取通过且只含本 Customer；两个停用后的旧 Token 读取拒绝检查失败。账号、Customer、Site、DeviceUser 共七条停用/失效操作均有真实审计 requestId。两个 Cognito 账号 Enabled=false，GlobalSignOut 成功，新登录均返回 INVALID_CREDENTIALS。临时凭证文件已删除、操作端密码变量已清空、两个临时登录标签页已关闭；原管理员标签页保留并恢复概览。停用记录及审计保留，未永久删除。凭证和 Token 不进入仓库。

## 问题与验收覆盖缺口

确认的问题统计：高 1 项；中等策略一致性观察 1 项。除此之外的 NOT RUN 为证据覆盖缺口，不冒充产品缺陷或已通过的验收项。

| ID | 级别/状态 | 证据与影响 | 后续处理 |
| --- | --- | --- | --- |
| H-01 | HIGH / OPEN | 两账号已在 UI/业务数据库停用，Cognito Enabled=false 且 GlobalSignOut 成功，新登录拒绝；但此前 ID Token 对自有 Site GET 仍为 200。失败 requestId：`2758c834-fc26-413a-83df-d9b223fab9e5`、`8427d717-29fe-4afb-a8ce-eba7843a7195`。 | 管理 API 应在执行业务读取/写入前检查被停用业务用户的状态并拒绝旧会话；补旧 Token 回归与真实部署后复验。当前不能证明停用即时撤销 API 访问。 |
| M-01 | MEDIUM / OPEN_POLICY_ALIGNMENT | CustomerViewer 共享权限矩阵含 device-user:read；真实 API 自有 DeviceUser 列表为 200，但 `/device-users` 前端路由明确排除 Viewer，浏览器返回 403。 | 核对冻结菜单角色事实与共享权限矩阵，统一所需的 API/路由/菜单和测试；本轮保留已有角色边界，没有改变权限。 |

源码追踪：管理入口 [lambda-entry.ts](../../apps/cloud-api/src/runtime/lambda-entry.ts) 的认证钩子调用首次激活同步；[user/service.ts](../../apps/cloud-api/src/admin/user/service.ts) 的 `activateInvitedUserOnAuthenticatedRequest` 对非 INVITED 用户返回 false，未拒绝 DISABLED 用户。JWT 验签仍然发生，但不能据此证明业务账号状态的即时撤销。M-01 对照 [路由角色](../../apps/admin-web/src/router/routes.ts) 与 [共享权限矩阵](../../packages/auth/src/permissions.ts)。这两处事实在验收对象中已存在。

两个旧 Token 的声明到期时间为 `2026-10-04T05:10:13Z` / `05:10:16Z`；测试仅证明停用后仍能访问，未持续持有或反复使用 Token 测量窗口，未测试到期后的结果。凭证及会话材料已经销毁，不宣称服务端旧 Token 撤销已成功。

剩余覆盖：Operator/Auditor 目标登录，真实非空分页/导出、媒体短链到期、设备同步、命令/OTA 端到端链路、目标桌面视口/多浏览器及持续性能、生产数据、当前 SHA 的 CI/部署工作流读取。当前两台设备离线、多数业务数据为空。这些流程继续保持未验收；限定站点隔离与 DeviceUser 乐观锁通过不能替代全部模块的真实业务验收。

## 正式目标 Gate 与证据

针对验收提交运行三个 Gate 的检查函数，默认回执均缺失：

- `check:admin-web-target-evidence`：`fe-06-10-admin-web-target.json` 缺失。
- `check:admin-web-fe11-15-target-evidence`：`fe-11-15-admin-web-target.json` 缺失。
- `check:admin-web-fe16-19-target-evidence`：`fe-16-19-admin-web-target.json` 缺失。

继续保持 **NOT RUN / NO RECEIPT**，未填写占位 PASS 或弱化 Gate。

当前汇总：[限定验收与失败结论](evidence/admin-ui-target-2026-10-04/completed-scoped-verification.json)、[30 次核心 API 探针](evidence/admin-ui-target-2026-10-04/scoped-api-verification.json)、[停用/旧会话失败证据](evidence/admin-ui-target-2026-10-04/scoped-account-cleanup.json)、[两角色浏览器验证](evidence/admin-ui-target-2026-10-04/scoped-browser-verification.json)、[七次停用审计](evidence/admin-ui-target-2026-10-04/owned-cleanup-audits.json)。

本轮证据目录：[admin-ui-target-2026-10-04](evidence/admin-ui-target-2026-10-04)。核心文件：[阶段回执](evidence/admin-ui-target-2026-10-04/incremental-verification.json)、[环境查询](evidence/admin-ui-target-2026-10-04/environment-observations.json)、[自建记录台账](evidence/admin-ui-target-2026-10-04/owned-fixture-ledger.json)、[四次写入审计](evidence/admin-ui-target-2026-10-04/owned-write-audits.json)、[页面观察](evidence/admin-ui-target-2026-10-04/route-observations.json)、[实际视口](evidence/admin-ui-target-2026-10-04/viewport-observation.json)。审计详情中的 IP 已脱敏；初始加载中观察保留为历史快照，后续配置页面已加载为空。

采集器见 `scripts/verify-admin-ui-scoped-target.mjs` 和 `scripts/verify-admin-ui-scoped-cleanup.mjs`，限定本轮已确认账号与 ID。采集后只调整脚本格式、凭证提供器缓存与进程退出处理；当前脚本通过静态检查，没有对已停用账号重跑真实写入。sourceCommit 绑定被测应用，不把新增采集器解释为该应用提交中的文件，未声称具备正式 Gate 的同执行器 SHA 回执。

验证：真实核心 API 探针 PASS；旧 Token 撤销探针 FAIL（保留原始失败）；证据引用/ID/请求数核对、脚本 ESLint/语法、Prettier、敏感信息扫描及 diff check。

后续执行应以本轮台账精确匹配对象，避免影响原有账号、设备及历史记录。所有提交仅在本地创建，远程推送由人工执行。
