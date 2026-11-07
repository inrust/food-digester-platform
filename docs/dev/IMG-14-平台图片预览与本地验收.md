# IMG-14 平台图片预览与本地验收

2026-11-07，基于本地提交 `342fb156` 实施。初始 main 工作区干净，已有十个未推送提交。本批仅本地开发、模拟 API 浏览器验证和离线检查，不部署、不连接或迁移目标库、不推送。

依据：[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、DEC-009@2.0.0、`camera-interaction-policy` 与 CT-06。交付设备查看页和 CT-06 同属 IMG-14 的设备操作页图片预览入口、租约与画面状态。IMG-15 的完整异常恢复验收、IMG-16 留档入口及设备 App 仍待后续执行。

## 修改范围

| 文件 | 内容 |
|---|---|
| `apps/admin-web/src/pages/devices/live-image-api.ts` | 管理端续租、读取、释放三个适配器，复用 P0 生成类型，URL 编码和 no-store |
| `pages/devices/live-image-session.ts` | 每次有效查看的 viewer、串行续租/读图链、取消/释放、状态解析和基本期限安全边界 |
| `pages/devices/LiveImagePreview.tsx` | 开始/停止、连接/等待/图片/暂停/错误、显式重新连接、visibility/pagehide/pageshow 清理 |
| `pages/devices/DeviceViewPage.tsx`、`app/feature-controllers.tsx`、`app/App.tsx` | 查看页装配、当前设备/Session 范围及角色粗筛，切换和清空选择清理，保留手动归档媒体入口 |
| `pages/device-operate/DeviceOperatePage.tsx`、`app/operations-controllers.tsx` | 操作页复用同一组件，URL 设备选择同步，满足已批准的 CT-06 摄像头开始/停止元素 |
| `pages/devices/device-state.ts`、`pages/device-operate/command-state.ts` | 实际按钮对应的 camPlay/camStop 覆盖锚点，不伪造未实现映射 |
| `api/http-client.ts` | 可选 signal/cache/keepalive 透传；取消后不因 Token 刷新或 401 再发送已关闭请求，其余请求默认行为保留 |
| `app/app.css`、`i18n/resources/en.ts`、`zh-CN.ts` | 使用已有视觉变量的响应式画面区；新增入口/状态双语文案 |
| `pages/audit/audit-state.ts` | 与 P0 observability 同步 imageBase64/jpegBase64 脱敏字段，防止审计展示镜像漂移 |
| `test/live-image-session.test.ts`、`live-image-preview.test.tsx`、`live-image-api.test.ts` | 新增生命周期、状态、取消及传输测试 |
| `test/http-client.test.ts`、`audit-logs.test.tsx`、`i18n.test.tsx` | 取消与刷新竞争、嵌套图片脱敏、页面模块计数及全源码文案校验 |
| `e2e/live-image-preview.spec.ts` | 查看页桌面/移动、操作页桌面的本地浏览器模拟验证、布局和截图 |
| 本文、开发计划、IMG-04 补充 | 执行结果、FAIL/WARN/NOT_RUN 和下一任务 |

没有新增后端路由、权限点、数据库迁移或云资源。平台只调用三个已有管理接口；设备 state 查询及上传接口仍由设备 App 使用。未修改冻结的政策、OpenAPI、生成类型或契约基线。

## 进入与查看

两页面默认关闭预览，只有用户明确打开后才申请 viewer。预览区与既有归档媒体手动刷新分开；不调用 S3 上传会话、不申请归档配额、不提供实时视频流或历史回放。

展示入口先依据已有 Session 的 device:read/media:read、设备原 Customer 范围及 Active/Maintenance 两轴状态作粗筛；权限/客户上下文和设备变化会销毁旧组件。真正的设备白名单、能力启用和授权判断仍由后端负责，前端不会把未启用的旧设备自动开启。服务器拒绝后进入无图错误态，原归档入口仍保留。

打开时为本次可见查看生成 crypto.randomUUID viewerId；在该有效查看期间用同一 ID 续租。关闭后重开、从隐藏恢复或切换身份/设备使用新 ID，防止旧释放请求误删新的查看租约。多个页面的 viewer 独立，设备 streamId 由服务端共享。

1. PUT `.../live-image/viewers/{viewerId}` 成功后开始读取。使用返回的固定 10 秒续租和 2000ms 读图参数，并核对与冻结策略一致。
2. 续租和读图分别串行：每次请求完成后再排下一次，不叠加慢请求。第一张等待期间显示等待画面，不复用归档图片。
3. READY 只接受相同 streamId、合法 frameId、JPEG MIME、有界 Base64 和合法日期。以固定 `data:image/jpeg;base64,...` 渲染，显示媒体拍摄时间。
4. 有当前帧才发送 afterFrameId。UNCHANGED 保留当前画面及原本的本地截止，不重新起算；WAITING_FRAME 清图并继续等待。
5. 切换/清空设备、关闭、离开页面或组件卸载取消在途请求与所有定时任务，并对该 viewer 发 DELETE。刷新同一设备的控制台不重建正在查看的预览。
6. document 隐藏或 pagehide 时同步停止请求并清图；恢复可见/pageshow 后，只有原来仍打开的预览会重新申请新 viewer，先显示连接状态。

状态及图片只保存在当前组件/会话内存，不写 localStorage、sessionStorage、审计或日志。界面关闭、隐藏或切换时立即去掉图片；解码失败也停止该租约。预览请求全部使用 fetch cache=no-store，不向 CORS 添加额外自定义缓存请求头。

## 基础安全边界及 IMG-15 交接

为使本批接入本身保持安全，已实现以下必要基础，不宣称 IMG-15 已完成：

- 根据服务端 meta.timestamp 与 expiresAt 差值扣除请求 RTT，使用单调时钟设置帧截止，最多 10 秒。该清图定时器独立于下一次请求，读图悬挂时也生效。
- 同 frameId 的重复 READY 不能延长已有本地截止，UNCHANGED 不能延长；已在本地过期的同帧不会再显示。租约也有本地截止，续租悬挂到期限会停止全部查看。
- 各查看实例具有独立活动标记和 AbortController；取消后到达的成功/失败回复不更新已结束会话。续租返回不同 streamId 时清图并要求重新开始。
- 网络、401/403/404/409/429、协议错误采用失败关闭与手动重新连接，避免错误期间继续展示旧帧。没有实现自动网络重试、退避或长期离线恢复。
- HTTP 客户端在 Token 等待之后、每次发送前和响应之后检查取消信号。已关闭的请求不会在认证刷新结束后被重新派发，也不会因已取消的 401 回复额外刷新/清除会话。

释放使用已有认证客户端和 keepalive，失败不输出原始数据。若续租在取消后仍完成，会再次释放旧 viewer。但浏览器取消不等于服务器事务回滚；突然断网/关闭进程、预检中断或无有效凭据时，释放只能尽力，未知在途租约最终由服务端 30 秒期限兜底。前端不会承诺撤回已经提交的服务端写入。

IMG-15 继续补齐极端迟到/时钟/身份变更矩阵、长请求超时与异常恢复策略、限频/重试语义、完整状态文案和更多浏览器生命周期证据；本批未将这些未执行内容标为完成。

## 本地检查

| 检查 | 结果 |
|---|---|
| 租约/组件/API/HTTP/i18n 专项 | PASS，5 文件、46 项 |
| 契约锚点/审计脱敏/操作页/租约/组件复验 | PASS，5 文件、73 项 |
| 仓库 Vitest 全套，maxWorkers=4 | PASS，216 文件、2085 项 |
| 最终 Chromium Playwright 专项 | PASS，3 项：查看页 1440px 英文、375px 中文，操作页 1440px 英文 |
| admin-web 及依赖类型检查、浏览器构建 | PASS；保留大分块 WARN |
| contracts 全套 | PASS，319 项 |
| OpenAPI | PASS，bundle 新鲜度与 Redocly |
| runtime/migration/CDK 检查脚本测试 | PASS，17 项 |
| 管理后台交付检查、134 REST 操作清单 | PASS |
| 迁移漂移、包边界、敏感 sink、secrets | PASS |
| 离线 CDK synth | PASS，无 warning；未部署，本批无 IaC 修改 |
| 本批 TS/TSX 的 ESLint、支持文件 Prettier、git diff --check | PASS |

浏览器测试只访问本地 Vite 和路由拦截的模拟 API，使用既有可校验 JPEG，没有生产凭据/真实云调用。核对自然解码宽度、可见图片、每页 viewer、开始前无预览请求、两秒读取、后台暂停/恢复、切换设备/清空选择释放、存储中无帧以及无横向溢出；关闭的归档媒体入口保持原行为。

已查看三张实际浏览器截图，标题、关闭按钮、画面、拍摄时间及移动换行正常。截图为本地测试产物，未混入 Git 源码或目标运行证据：

- `/tmp/fdp-img14-view-1440.png`
- `/tmp/fdp-img14-view-375.png`
- `/tmp/fdp-img14-operate-1440.png`

### FAIL / 环境阻断及修复

- 初轮专项 41 PASS/1 FAIL：i18n 扫描把页面 TSX 模块固定为 24，新增共享预览组件后为 25。更新精确模块计数，仍扫描全 UI 源码，未删除文案约束。
- 一次 admin-web typecheck FAIL：fetch 测试的简化返回对象不满足完整 Response 类型，改用真实 `new Response(null,{status:204})`，没有放宽生产接口。
- 第一次 Playwright 构建成功但 Vite 监听 127.0.0.1:4173 被沙箱 EPERM 阻止。通过自动审批允许本机测试服务后，原两项通过；补齐操作页及最终源码后，最终三项通过。没有以端口问题替代浏览器验证，也没有部署公网服务。
- 首次全量 Vitest 为 215 文件/2082 项 PASS、1 文件/3 项 FAIL：P0 已 Adapt 的查看/操作页 camPlay/camStop 缺实现锚点，前端审计 Base64 脱敏镜像也落后于 observability。操作页复用实际组件后补齐锚点，并同步脱敏及嵌套断言；保留原 parity 校验，最终全量通过。

最终未解决 FAIL=0、BLOCKED=0。

### WARN

Vite 报告压缩后仍存在超过 500kB 的 JS 分块（当前浏览器包约 1.37MB）；Playwright 子进程另有 NO_COLOR/FORCE_COLOR 环境提示。本批保留这些警告，没有修改门槛、屏蔽输出或扩大范围重做打包拆分。构建和浏览器测试均通过，性能预算仍需后续实测。

### NOT_RUN

- 真实公开域名的 Cognito/API Gateway/CORS/CSP、设备能力白名单、mTLS 上传、真实网络缓存及权限撤销传播。
- 真实 DynamoDB、PostgreSQL 多连接和设备拍摄上传；浏览器模拟响应不替代共享存储或服务端原子性证明。
- Firefox/Safari/Edge、多浏览器兼容矩阵、原生 OS 后台/移动挂起/BFCache/浏览器强杀及未知服务端写入结果。
- 完整 Playwright 历史套件、全仓 pnpm verify、正式 G3/目标 Gate；本批只新增并执行三项浏览器专项，Vitest 全套不等同这些门禁。
- IMG-15 的完整异常恢复验收、IMG-16 留档图片页面、IMG-17～18 设备 App，设备规模、首帧等待目标及真实负载/性能预算。
- 云资源部署、目标库连接/迁移、Git 推送。

G1/G2 保持原 PARTIAL；G3 现有 IMG-14 本地模拟页面证据，仍为 PARTIAL，未达到完整本地集成或目标验收。下一可执行任务是 IMG-15：在本批基础上补齐异常恢复、期限与迟到响应矩阵、状态国际化和浏览器验证，不重新实现第二套租约管理。

## 复现命令

使用 Node 24.22.1、`/opt/homebrew/bin/pnpm` 10.20.0。以下 pnpm 指该绝对路径，Playwright 需允许启动本机 127.0.0.1:4173；所有外部业务请求由测试拦截。

```sh
pnpm exec vitest run apps/admin-web/test/live-image-session.test.ts apps/admin-web/test/live-image-preview.test.tsx apps/admin-web/test/live-image-api.test.ts apps/admin-web/test/http-client.test.ts apps/admin-web/test/i18n.test.tsx --maxWorkers=4
pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts apps/admin-web/test/audit-logs.test.tsx apps/admin-web/test/device-operate.test.tsx apps/admin-web/test/live-image-session.test.ts apps/admin-web/test/live-image-preview.test.tsx --maxWorkers=4
pnpm exec vitest run --maxWorkers=4
PATH=/opt/homebrew/bin:$PATH pnpm --filter @fdp/admin-web exec playwright test e2e/live-image-preview.spec.ts
pnpm --filter @fdp/admin-web... typecheck
pnpm --filter @fdp/admin-web... build
pnpm test:contracts
pnpm openapi:check
node --import tsx --test scripts/check-delivered-runtime.test.mjs scripts/check-migrations.test.mjs scripts/check-cdk-synth.test.mjs
node scripts/check-admin-web-delivery.mjs
node scripts/check-migrations.mjs
node scripts/check-boundaries.mjs
node scripts/check-sensitive-sinks.mjs
node scripts/check-secrets.mjs
node --import tsx scripts/check-delivered-runtime.mjs
PATH=/opt/homebrew/bin:$PATH AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-1 node scripts/check-cdk-synth.mjs
```

另对本批改动源码/测试执行定向 ESLint/Prettier、git diff --check。本批没有 deploy、目标 prisma migrate 或 push。
