# 管理后台 811a895：五角色、双 Customer 非空链路与三浏览器验收

## 结论与范围

已部署应用 `811a8959477d7b2608f2562b5d221f8b40370944` 的本轮限定范围验收通过：真实 Cognito 登录、五角色权限矩阵、两个 Customer 的非空 Site / DeviceUser 查询与隔离、限定写入与并发冲突、停用后同一未过期 Token 读写拒绝，以及安装版 Chrome / Edge / 官方 Firefox 的桌面兼容性。最终真实 API 回执包含 152 个请求、400 项断言；浏览器回执包含 15 个角色×浏览器用例、330 项路由检查、474 项检查、57 张截图。所有本轮对象均完成清理。

人工复核截图发现 **M-02：切换语言后业务页面文案未即时刷新**。本地已修复并增加回归测试；目标环境仍是 811a895，不能把本地修复记为目标复验通过。`productionAccepted=false`、`fullAdminTargetAccepted=false`；本报告不替代 FE-06～19 的完整目标环境回执。

环境：`https://admin.bio-nexa.com`、`https://api.bio-nexa.com/api/v1/admin`；AWS 账号 `065986019555`、区域 `ap-southeast-1`、应用栈 `fdp-test-app`。虽然使用真实 AWS 服务和在线数据，业务写入仅限明确批准的本轮测试对象，没有改动既有业务记录、设备、权限或云部署配置。

## 版本、CI 与部署绑定

| 检查 | 结果 / 证据 |
| --- | --- |
| GitHub CI | [37191542287](https://github.com/inrust/food-digester-platform/actions/runs/37191542287)，completed / success，精确 811a895 |
| GitHub 自动部署 | [37191542285](https://github.com/inrust/food-digester-platform/actions/runs/37191542285)，completed / success，精确 811a895 |
| Amplify main | job 55，SUCCEED，精确 811a895 |
| Lambda / CloudFormation / S3 | 19 个函数均核对部署资产、源版本与完整 ZIP 摘要；327 次有界分段读取重组后与当前 CodeSha256 一致 |
| 验收后复核 | 19 个函数的 CodeSha256、RevisionId、状态及 Amplify 版本不变；仅复用与当前不可变资产绑定完全相同的已验证字节 |

[验收前版本回执](evidence/admin-ui-811a895-formal-2026-10-04/application-version.json)、[验收后版本回执](evidence/admin-ui-811a895-formal-2026-10-04/application-version-after.json)、[CI 元数据](evidence/admin-ui-811a895-formal-2026-10-04/github-ci.json)、[部署元数据](evidence/admin-ui-811a895-formal-2026-10-04/github-deploy.json)、[CI 验证节选](evidence/admin-ui-811a895-formal-2026-10-04/github-ci-validation-excerpt.txt)。早期 CI 未完成的 BLOCKED 回执保存在 [version-attempt-ci-pending.json](evidence/admin-ui-811a895-formal-2026-10-04/version-attempt-ci-pending.json)，没有覆盖。

版本证明来自精确提交的成功自动部署、已部署 CloudFormation 资产与 Lambda 字节核对；应用没有独立的 build-commit 环境变量。这里不把页面正常打开等同于版本证明，也不把待提交的本地语言修复视为已部署。

## 授权对象与五角色权限

用户明确批准创建首轮及重跑临时账号、在验收后全部停用；另明确批准 Firefox 首次条款，以及 Playwright 直接启动安装版 Chrome / Edge、官方 GeckoDriver 控制 Firefox。执行器仅操作本轮对象。重跑账号前缀为 `ui-formal-811a895-r2-`，域名为 `example.invalid`。

| 角色 | 账号后缀 | Customer 范围 | 22 条受保护路由允许 / 拒绝 | DeviceUser 写控件 |
| --- | --- | --- | --- | --- |
| PlatformSuperAdmin | superadmin | 平台范围 | 22 / 0 | 6 |
| PlatformOperator | operator | 平台范围 | 18 / 4 | 整页 403 |
| Auditor | auditor | 平台范围只读 | 18 / 4 | 0 |
| CustomerAdmin | admin | 仅 A | 13 / 9 | 6，仅自有范围 |
| CustomerViewer | viewer | 仅 B | 11 / 11 | 0 |

Customer A：`003c38ec-2e05-475f-9f72-33e079dff78a`；Customer B：`6ca7f97f-afe4-4aca-93da-460e04656b95`。两者均有独立 Site、DeviceUser 和 DRAFT Contract，各两个，记录 ID、归属和最终状态见 [对象清单](evidence/admin-ui-811a895-formal-2026-10-04/owned-fixture-ledger.json)。

每个角色均执行 13 类 API 读取权限检查，共 65 次：Customer、Site、Device、Contract、License、Configuration、DeviceUser、Alarm、Dashboard、Audit、User、Settings、Report。预期来自当前 `hasPermission`；每次保留状态、请求编号和 PASS 断言。路由权限另按 `APP_ROUTES` 检查，菜单不包含全部直接访问路由，不能将菜单数量代替权限覆盖率。

实际 API 读取状态矩阵（200 为允许，403 为角色拒绝；非空与归属另按下节断言）：

| API | SuperAdmin | Operator | Auditor | CustomerAdmin | Viewer |
| --- | --- | --- | --- | --- | --- |
| Customer | 200 | 200 | 200 | 403 | 403 |
| Site | 200 | 200 | 200 | 200 | 200 |
| Device | 200 | 200 | 200 | 200 | 200 |
| Contract | 200 | 200 | 200 | 403 | 403 |
| License | 200 | 200 | 200 | 403 | 403 |
| Configuration | 200 | 200 | 200 | 403 | 403 |
| DeviceUser | 200 | 403 | 200 | 200 | 200 |
| Alarm | 200 | 200 | 200 | 200 | 200 |
| Dashboard | 200 | 200 | 200 | 200 | 200 |
| Audit | 200 | 403 | 200 | 403 | 403 |
| User | 200 | 403 | 200 | 403 | 403 |
| Settings | 200 | 403 | 200 | 403 | 403 |
| Report | 200 | 200 | 200 | 200 | 200 |

## 真实业务与安全回归

[最终真实 API 回执](evidence/admin-ui-811a895-formal-2026-10-04/real-business.json) 状态为 `PASS_SCOPED_FIVE_ROLE_CROSS_CUSTOMER`，执行时间为 UTC 10:21:10～10:39:43（北京时间 18:21:10～18:39:43）。152 次请求的实际状态为 99×200、6×201、32×403、10×401、3×404、2×409；拒绝和冲突是预期成功分支。

| 行为 | 验证结果与限制 |
| --- | --- |
| Cognito 身份 | 五个真实 SRP 登录，校验 ID Token 的 issuer、tokenUse、角色、sub、Customer 归属；新账号状态、组与测试范围先行核对 |
| Site 查询 | 五角色分别查 A / B；平台角色可读两者，Customer 角色自有 200、跨 Customer 403 |
| DeviceUser 详情 | 具备读取权限的四角色分别查 A / B；Customer 角色自有 200、外租户 404；Operator 整体 403 |
| DeviceUser 列表 | Customer 请求携带外 Customer 过滤参数时，服务强制使用其自有 Customer，返回 200；断言精确非空自有 ID 与 customerId，确保无跨租户返回 |
| 重复创建并发 | CustomerAdmin 两个同时创建请求：恰好一个 201、一个 409 |
| If-Match 并发 | 同一 DeviceUser 版本两个同时更新请求：恰好一个 200、一个 409 |
| CustomerAdmin 跨租户写 | 404 / 403，外租户记录不改变 |
| Viewer 只读 | 新建、修改、重置密码、停用、分配、撤销六类写请求全部 403，自有 DeviceUser 仍 v1 / ACTIVE，浏览器无写控件 |
| Contract | Root 创建 A / B 的 DRAFT 合约，清理时 TERMINATED；没有激活、绑定授权或设备 |
| 停用旧 Token | 五角色各自原 SDK 登录 Token，在浏览器登出后、停用前读取 Site 仍 200；随后业务账号 DISABLED、Cognito Enabled=false；同一 Token 的读取与写入均 401 / UNAUTHENTICATED，校验相同摘要且请求时未过期 |

Viewer 的分配 / 撤销拒绝使用不存在的 UUID，仅证明权限检查先于业务查找，不能称为真实设备分配成功链路。并发检查是两个同时写入的正确性检查，不能称为容量、持续负载或 SLO 验收。身份凭证仅在内存与临时 0600 登录文件中使用；仓库只保存摘要、有效期和请求编号，不保存密码、Token 或 AWS 凭证。

## Chrome / Edge / Firefox 实际执行

| 浏览器 | 实际版本与执行方式 | 五角色结果 |
| --- | --- | --- |
| Chrome | 154.0.8037.95；Playwright 启动 `/Applications/Google Chrome.app` 的可执行程序 | 5 / 5 PASS |
| Edge | 154.0.4258.53；Playwright 启动 `/Applications/Microsoft Edge.app` 的可执行程序 | 5 / 5 PASS |
| Firefox | 官方 Mozilla Firefox 157.0；官方 GeckoDriver 0.37.1、标准 WebDriver、独立临时 profile | 5 / 5 PASS |

[浏览器回执](evidence/admin-ui-811a895-formal-2026-10-04/browsers.json) 记录 UTC 10:29:20～10:36:37（北京时间 18:29:20～18:36:37）。预检时 Chrome 曾为 152；正式运行已更新为表中的 154，保留 [预检记录](evidence/admin-ui-811a895-formal-2026-10-04/vendor-browser-preflight.json) 不覆盖。

15 个用例都通过真实登录表单获取会话，没有注入 JWT、拦截或 mock API。每个用例遍历 22 条受保护路由，核对角色允许 / 拒绝、精确 URL、403 页面、1366×768 无页面横向溢出，合计 330 条路由；拒绝页按当前产品设计保留原 URL 并显示独立 403 页面，没有伪造跳转。另检查非空自有 Site 详情、1440×900 桌面布局、英文外壳、语言持久化及登出；有 DeviceUser 权限的角色检查自有详情和控件。

Root / CustomerAdmin 在三款浏览器中都验证修改弹窗焦点、必填原因禁止空提交、真实自有 DeviceUser 修改及刷新读回，共六次最终浏览器正向更新；没有修改外租户或既有业务数据。474 项浏览器检查全部 PASS，57 张最终截图均绑定 SHA256。Chrome / Edge 另记录 388 条真实 API 响应及请求编号（384×200、4×403），无 5xx；Firefox 使用标准 WebDriver DOM 和持久化读回，没有把 Chrome / Edge 的网络日志冒充为 Firefox 网络证据。

代表证据：[Chrome Viewer 只读详情](evidence/admin-ui-811a895-formal-2026-10-04/chrome-customerviewer-device-user-1366x768.png)、[Edge 编辑必填原因](evidence/admin-ui-811a895-formal-2026-10-04/edge-customeradmin-edit-required-reason.png)、[Firefox Auditor 只读详情](evidence/admin-ui-811a895-formal-2026-10-04/firefox-auditor-device-user-1366x768.png)、[Firefox 英文外壳及 M-02](evidence/admin-ui-811a895-formal-2026-10-04/firefox-customerviewer-site-english-1440x900.png)。已人工复核这些截图及其他代表截图；未把 57 张截图称为全部逐张人工 UX 评审。

Firefox 官方安装包摘要、签名、TeamID、notarization 和 GeckoDriver 官方下载摘要已核对。直接执行 Firefox 遇到 macOS profile 启动失败，保留 [启动失败日志](evidence/admin-ui-811a895-formal-2026-10-04/firefox-public-startup-failure.txt)。使用 LaunchServices 启动官方应用，再由 GeckoDriver `--connect-existing` 连接独立 profile；`acceptInsecureCerts=false`，没有降低证书、鉴权或沙箱保护。该处理与 [Mozilla 已记录的 macOS 启动问题](https://bugzilla.mozilla.org/show_bug.cgi?id=2062988)一致，参数依据 [官方 GeckoDriver 文档](https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html)。

## M-02：语言即时切换修复与未部署边界

811a895 的截图显示切到 English 后侧栏、顶部栏与面包屑已更新，但 Site 页标题、筛选、表头和详情标签仍中文。浏览器 `english-layout` 只证明英文外壳、文档语言和无溢出，`language-persists-reload` 证明刷新持久化；两项不能证明业务文案即时切换。因此完整双语言即时切换验收为 **FAIL on deployed 811a895 / local fix PASS / target recheck NOT RUN**。

根因：页面使用共享 `translate()`，应用组合根未订阅语言 Context；语言变化只驱动订阅者（外壳等）重新渲染。本地修改 `apps/admin-web/src/app/App.tsx`，使 `AdminWebAppInner` 订阅 `useI18n()`，保持页面和表单组件身份，不用 key 或重挂载刷新界面。

新增 `apps/admin-web/test/app-smoke.test.tsx` 回归：当前客户页及已打开表单 zh-CN → en → zh-CN 即时更新；输入 DOM 身份及未保存值保持；URL 不变；仍只有最初一次 GET，没有额外请求或业务写入。修复前该用例失败，修复后该文件 10 / 10 通过，见 [失败与通过节选](evidence/admin-ui-811a895-formal-2026-10-04/language-regression.txt)。这是本地单元测试，使用本地服务替身，不冒充真实环境或三浏览器对新修复的验收。

## 失败保留、执行器修正与严格检查

首轮 API 执行器错误地要求外 Customer 列表过滤 403；现有服务实际强制自有范围并返回 200。保留 [首轮 FAIL 回执](evidence/admin-ui-811a895-formal-2026-10-04/attempt-1/real-business.json)（116 请求、317 断言）及其执行字节、13 项清理；不依据首轮仅状态的记录宣称已证明无泄漏。重跑在 fresh fixtures 上增加精确非空 ID / 归属断言，保留严格隔离检查。

首轮浏览器执行器错误期待禁止路由跳转到 `/403`，并在 Firefox 客户筛选选项加载前选择，保留 [浏览器首轮 FAIL 回执](evidence/admin-ui-811a895-formal-2026-10-04/browser-attempt-1/browsers.json)及执行器、截图。修正为检查原 URL 的 403 页面，等待实际异步数据和选项；最终再完整跑五角色×三浏览器。

最终执行器的已存回执另有字段命名问题：`owned-device-user-edit-persisted` 检查中的 detail.id 覆盖检查 ID，使回执 id 实际为自有 DeviceUser ID。原始回执和原始执行字节保持不动；独立 Gate 同时检查精确自有 DeviceUser ID、Customer 归属、PASS、摘要绑定的 persisted 截图。当前脚本修正为 `deviceUserId` 并防止覆盖检查 id / result，增加外记录替换负例，不降低验证条件。原始字节见 [真实业务执行器](evidence/admin-ui-811a895-formal-2026-10-04/real-business-executor.mjs)、[浏览器执行器](evidence/admin-ui-811a895-formal-2026-10-04/browser-executor.mjs)。

独立限定范围 Gate：`scripts/check-admin-ui-811a895-formal.mjs`，155 项严格检查；`scripts/check-admin-ui-811a895-formal.test.mjs`，真实归档证据正例及 20 个负例，共 21 / 21 通过。负例涵盖缺角色、错 SHA、未验证 Lambda、运行漂移、mock、空租户、跨租户列表泄漏、Viewer 写入、过期 Token、并发双成功、错误浏览器、缺用例、越权业务页、缺截图、错记录读回、清理缺失、凭证残留和扩大验收结论。未修改既有 FE-06～19 或完整 AWS 目标 Gate。

只读重验命令（不创建账号、不发业务请求）：

```sh
node --import tsx scripts/check-admin-ui-811a895-formal.mjs docs/audit/evidence/admin-ui-811a895-formal-2026-10-04
node --import tsx --test scripts/check-admin-ui-811a895-formal.test.mjs
```

[限定 Gate 回执](evidence/admin-ui-811a895-formal-2026-10-04/scoped-gate.json)、[21 项测试结果](evidence/admin-ui-811a895-formal-2026-10-04/scoped-gate-tests.txt)。两个历史真实执行器均防止覆盖回执或复用已停用账号，不能直接重放这些已清理对象。

## 清理、证据与本地验证

两轮各 13 个对象，共 26 个：10 个临时管理员账号业务 DISABLED、Cognito Enabled=false；4 个 Customer / 4 个 Site 为 SUSPENDED；4 个 DeviceUser 为 DISABLED；4 个 Contract 为 TERMINATED。保留审计记录，没有永久删除，未重新启用历史测试账号。最终 Root 无法用自己的会话停用自己，使用用户原管理员会话停用，然后校验 Cognito 与旧 Token 拒绝。用户原管理员账号和原 GitHub 标签页保留。

[首轮清理清单](evidence/admin-ui-811a895-formal-2026-10-04/attempt-1/owned-fixture-ledger.json)、[重跑清理清单](evidence/admin-ui-811a895-formal-2026-10-04/owned-fixture-ledger.json)、[全部重跑账号停用截图](evidence/admin-ui-811a895-formal-2026-10-04/retry-five-disabled.jpg)、[停用 DOM](evidence/admin-ui-811a895-formal-2026-10-04/retry-five-disabled-dom.txt)。临时 0600 登录文件已删除；自动化浏览器上下文和独立 Firefox profile 已关闭 / 清理，验收用 CI 标签页已关闭。

完整本地 `pnpm verify` 结果及实际套件计数见 [本地验证回执](evidence/admin-ui-811a895-formal-2026-10-04/local-validation.json)和[验证日志节选](evidence/admin-ui-811a895-formal-2026-10-04/local-verify-excerpts.txt)。首次运行新增测试 default import 的类型检查失败；改为依照项目惯例的 named import 后完整重跑，不跳过检查。最终数字按该回执解释；本地测试不替代目标验收。

最终完整验证退出码 0（北京时间 18:48:18～18:57:40）：单元 1341、契约 301、脚本 455、基础浏览器 35、QA-05 串行 35 + 并行重复 70 = 105、QA-08 24 均通过；七个本地 Gate 均新生成且 PASS，原始本地回执保存在 `evidence/admin-ui-811a895-formal-2026-10-04/local-gates/`。本地验证回执绑定修改后 App / 测试 / 四个新增脚本的文件摘要，不将 Git 基线 811a895 冒充为已部署修复版本。[浏览器清理记录](evidence/admin-ui-811a895-formal-2026-10-04/browser-cleanup.json)另确认本轮临时 Firefox 无残留进程、自动化 profile 与私有登录文件均已清理。

[发布前扫描](evidence/admin-ui-811a895-formal-2026-10-04/publication-scan.json)、[证据摘要清单](evidence/admin-ui-811a895-formal-2026-10-04/artifact-hashes.json)记录文本敏感内容检查和所有交付证据的摘要。仅 DOM / 日志去除行尾空白；不可变 JSON 回执与已执行原始脚本未重写。本轮只创建本地提交，不推送远程。

## 未完成范围与下一步

| 范围 | 当前状态 | 下一步 |
| --- | --- | --- |
| M-02 真实环境即时语言切换 | 本地修复通过，目标 NOT RUN | 人工 GitHub Desktop 推送本地提交，核对自动部署的新应用 SHA，再复验页标题 / 表头 / 表单 / 未保存状态及三浏览器 |
| 真实设备非空链路 | NOT RUN / NO RECEIPT | 明确可操作设备和隔离对象，执行入网、遥测、指令、设备用户分配 / 撤销及授权生效 |
| 查询导出、审批、配置发布等完整业务 | 本轮仅权限路由 / 部分读取 | 补 ESG 非空导出、媒体审核、配置发布与同步、License 绑定 / 激活、OTA、耗材等成功及拒绝链路，按 FE-06～19 正式 schema 生成目标回执 |
| 持续并发容量与 SLO | NOT RUN / NO RECEIPT | 单独确定时长、流量、错误率 / 延迟阈值及测试数据范围 |
| 生产最终验收 | 未授予 PASS | 完整业务、真实设备与容量证据齐备后独立审核；本次限定 Gate 不升级为全业务或生产 PASS |

三浏览器与双 Customer 非空 Site / DeviceUser 的限定范围缺口已补齐；剩余任务按上述边界继续。历史结论与证据见 [3f54e8a 目标复验](2026-10-04-admin-ui-3f54e8a-target-recheck.md)。
