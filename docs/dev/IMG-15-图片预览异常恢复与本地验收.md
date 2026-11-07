# IMG-15 图片预览异常恢复与本地验收

2026-11-07，基于 `e16a753fb7508b74c0c70fa833690630b20a84b7`（IMG-14）实施。进入时 main 工作区干净，已有 11 个未推送提交。按用户授权只进行本地开发与检查，创建本地提交，不推送、不部署、不连接或迁移目标库。

依据：[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、DEC-009@2.0.0 和冻结的 camera-interaction-policy。复用 IMG-14 的共享预览组件和租约管理，每次可见查看中只有一条续租链和一条不重叠的读图链；查看页和操作页同时获得本批修复。

## 完成行为

| 场景 | 处理 |
|---|---|
| 单次申请、续租或读图长时间不返回 | 12 秒客户端 watchdog，AbortSignal 取消并退出等待；即使传输忽略取消也不阻塞下一代会话 |
| 网络错误、503 等服务故障、请求超时 | 立即清图、取消旧代全部请求/定时器、尽力释放旧 viewer；2/4/8 秒退避，最多自动重试三次，仍失败则停止并提供人工重连 |
| LIVE_VIEWER_EXPIRED / LIVE_STREAM_INACTIVE | 清理旧代，仍可见且未关闭时按相同有界退避重新申请新 viewer，不复用旧 stream 的响应 |
| 429、带 Retry-After 的服务错误 | 等待 max(本次退避, Retry-After)，支持整数秒和 HTTP 日期；无效值不覆盖默认退避。超长合法值分段定时，防止 setTimeout 溢出后立即重试 |
| 隐藏、pagehide、关闭后重新打开 | 仍取消/释放旧代；组件内保存单调时钟的重试截止，恢复和人工操作不能提前绕过收到的 Retry-After。设备/身份组件销毁后不持久化此信息，服务端仍负责权威限频 |
| 自动重试次数耗尽 | 停止并展示原因及三次重试仍未恢复的说明；人工重连开启新一轮，仍遵守未到期的服务端等待期限 |
| 401 / 403 / 404 | 不自动重试，清图并停止。隐藏再恢复不会复活已拒绝的预览；明确人工重连或重新打开后仍必须重新通过后端鉴权 |
| 协议损坏、无效 MIME/Base64、响应 stream 不符、浏览器解码失败 | 停止并显示对应本地化文案，防止把坏响应误判为网络故障持续重试 |
| 租约先于请求 watchdog 到期 | 独立租约期限立即清理并取消请求；读图发布和续租更新前还核对原租约本地期限，不依赖过期回调已得到执行 |
| 帧最长 10 秒、UNCHANGED、同帧 READY 重放 | 继续用服务器时间差减完整 RTT、上限 10 秒和单调时钟建立期限；UNCHANGED/同 ID 不延长原期限，过期独立清图。过期但迟到的 READY 不展示 |
| 旧请求迟到 | 每代闭包失效后不能发布状态；超时、隐藏或关闭后的旧 GET 不覆盖新画面；旧 PUT 成功或取消后结果未知时补偿释放自己的旧 viewer，不释放新 viewer |

冻结的 30 秒租约、10 秒续租、2000ms 读图、10 秒帧有效期、JPEG/Base64 规格及三个管理接口均不变。12 秒 watchdog 和 2/4/8 秒恢复属于浏览器故障处理参数，不修改设备采样周期、后端状态或云端限频策略。退避次数在同一次可见查看内累计，收到画面不会立即重置，避免持续抖动时无限自动重连。快速隐藏/恢复或关闭/重开被 React 同批处理时，也显式更新启动代次，防止可见页面残留已停止的引擎。

释放仍为 authenticated keepalive DELETE、尽力而为；AbortSignal 不是服务端事务回滚。浏览器已终止传输但服务端仍在处理的未知结果，不能由浏览器保证补偿成功，最多 30 秒的服务器租约为最终边界。未知结果不表述为已释放成功。真实云端撤权与已经发出响应之间的边界沿用后端协议，本地验证不证明公网撤权传播时延。

HTTP 传输仅增加可选 retryAfterMs；无此头时旧响应对象结构不变，既有错误构造参数兼容。保留原 401 刷新一次和清会话机制，以及取消后不继续 Token 刷新/发送的检查。现有 admin CORS 已暴露 Retry-After，本批没有新增权限、云端路由或 IaC。HTTP 日期形式依据客户端当前墙上时钟换算等待时长，随后用单调时钟等待；终端时钟严重偏差及真实跨域头可见性留待目标验证。

## 状态与文案

中英文资源同步提供：连接、等待首帧、画面可用、上一帧已过期、页面隐藏暂停、自动恢复、停止，以及登录失效、权限失效、设备不可用、限频、超时、服务故障、会话过期、协议异常、图片解码和网络故障原因。显示明确的“至少等待 N 秒后再连接”，该数字为本次开始等待的间隔提示，不冒充逐秒倒计时。

错误区不再展示服务端 message 或内部英文异常；仅保留 requestId 供排查。图片仍只存在组件内存，不写 local/sessionStorage、审计或控制台，不与事件留档/S3 下载或上传会话配额混用。未设首帧超时承诺：首帧等待验收目标尚未确认，单次 HTTP watchdog 不代表首帧 SLA。

## 修改文件

| 文件 | 修改 |
|---|---|
| `apps/admin-web/src/pages/devices/live-image-session.ts` | 复用原单代逻辑，增加有界恢复管理、每代 viewer、请求 watchdog、租约发布前期限校验、迟到补偿、过期/恢复/耗尽状态 |
| `apps/admin-web/src/pages/devices/LiveImagePreview.tsx` | 保留重试截止，拒绝态跨隐藏恢复保持停止，译文原因与手动重连，解码失败停止 |
| `apps/admin-web/src/api/errors.ts`、`http-client.ts` | 可选 Retry-After 元数据解析与错误传播，旧客户端默认行为兼容 |
| `apps/admin-web/src/i18n/resources/en.ts`、`zh-CN.ts` | 完整状态/原因/等待及耗尽文案，保持键集合一致 |
| `apps/admin-web/test/live-image-session.test.ts` | 超时、期限、恢复、429、超长等待、迟到 PUT/GET、撤权和坏响应矩阵 |
| `apps/admin-web/test/live-image-preview.test.tsx` | 中英文权限提示、隐藏不绕过拒绝、请求悬挂时清图、冷却跨隐藏与重开、同批 pagehide/pageshow 和关闭重开 |
| `apps/admin-web/test/live-image-api.test.ts`、`http-client.test.ts` | Retry-After 秒/日期/零/坏值/越界值，包络及非 JSON 网关错误传播，保留旧传输断言 |
| `apps/admin-web/e2e/live-image-recovery.spec.ts` | 本地 Chromium 真实 JPEG、独立期限、旧代迟到、真实 HTTP 429 头、冷却与 403 的中英文浏览器验证 |
| 本文、开发计划、IMG-04 补充 | 进度、检查证据、历史失败及 NOT_RUN 边界 |

## 本地检查

所有命令在仓库根执行，pnpm 使用 `/opt/homebrew/bin/pnpm` 10.20.0，Node 24.22.1。日志 `/tmp/img15-*.log` 是本机临时检查产物，不是目标环境验收材料。

| 检查 / 命令 | 结果 |
|---|---|
| `pnpm exec vitest run --maxWorkers=4` | PASS，216 文件、2114 项（最终源码） |
| 租约引擎/组件/API/HTTP/i18n 专项 | PASS，5 文件、75 项 |
| `pnpm --filter @fdp/admin-web... typecheck` | PASS，含依赖与 e2e TypeScript |
| `pnpm --filter @fdp/admin-web exec playwright test e2e/live-image-preview.spec.ts e2e/live-image-recovery.spec.ts` | PASS，6 项；构建、查看页桌面/移动、操作页及本批异常矩阵 |
| `pnpm test:contracts` | PASS，319 项 |
| `pnpm openapi:check` | PASS，bundle 新鲜度和 Redocly |
| `node --import tsx --test scripts/check-delivered-runtime.test.mjs scripts/check-migrations.test.mjs scripts/check-cdk-synth.test.mjs` | PASS，17 项 |
| `node scripts/check-admin-web-delivery.mjs` | PASS |
| `node --import tsx scripts/check-delivered-runtime.mjs` | PASS，134 operations |
| `node scripts/check-boundaries.mjs`、`check-sensitive-sinks.mjs`、`check-secrets.mjs`、`check-migrations.mjs` | PASS |
| `node scripts/check-cdk-synth.mjs`（禁用凭据、元数据查询，固定合成 account/region） | PASS，离线 synth 无 warning；没有部署 |
| 本批 TS/TSX ESLint、支持文件 Prettier、`git diff --check` | PASS；docs 按仓库 .prettierignore 排除，另审阅内容和链接 |

浏览器测试通过已有 qa05 防护禁止未拦截 API 和外网请求。新增三项使用浏览器可控时钟推进期限，并通过本地模拟服务器返回真实 Retry-After 头；不是依赖墙上时钟 sleep。原 IMG-14 三项仍验证真实 JPEG 解码、移动布局和设备切换。

已查看 `/tmp/fdp-img15-en.png`、`/tmp/fdp-img15-zh-CN.png` 两张浏览器截图，停止状态不保留图片，提示、requestId 和重连按钮可读。截图与 Playwright trace 仅为临时本地附件，未混入源码或声称目标验收。

### FAIL / 修复记录

- 首轮定向测试 34 PASS / 5 FAIL：IMG-14 原断言将网络/429/409 视作终止，以及等待 30 秒后检查终止；本批新增恢复和 12 秒 watchdog 后这些预期失效。将其更新为明确的恢复时间、旧代释放、新 viewer 和有界重试断言，同时保留 401/403/404、坏协议的停止断言。随后定向检查通过，未删除期限或授权约束。
- 首次前端 typecheck FAIL：exactOptionalPropertyTypes 不允许为可选 viewerId 显式传 undefined。改为每次恢复明确生成新的 UUID，没有放宽类型。首次 Playwright 因同一 TypeScript 编译错误未启动（NOT_RUN 浏览器测试），修复后 typecheck 和六项浏览器回归通过。
- 本机 `python` 命令不存在，改用 `python3` 执行编辑辅助脚本；不涉及应用运行依赖。

最终未解决 FAIL=0、BLOCKED=0；以上历史失败保留。

### WARN

保留 Vite 超过 500kB 的大分块提示，以及 Playwright 子进程 NO_COLOR/FORCE_COLOR 环境提示。构建和浏览器回归均通过，本批不改变门槛或扩展为打包重构。

### NOT_RUN

- 真实 Cognito/API Gateway/公开域名 CORS/CSP、Retry-After 头可见性、真实网络缓存与撤权传播；浏览器 mock 不等于公开接口验收。
- 真实 DynamoDB、PostgreSQL 多连接、实际设备白名单/租户迁移及 mTLS 帧上传；本批不连接目标库，不执行迁移。
- Firefox/Safari/Edge、真实移动系统后台/挂起、原生 BFCache、强杀页面、离线恢复与系统时钟严重偏差的完整兼容矩阵。测试中的 visibility/pagehide/pageshow/浏览器可控时钟不能替代这些证据。
- 真实网络抖动/负载、设备规模与并发规模、首帧等待目标、长期运行和性能预算。
- 完整历史 Playwright、全仓 `pnpm verify`、正式 G3/目标 Gate；只执行 IMG-14/15 六项浏览器专项和列出的本地检查。
- IMG-16 留档图片页面、IMG-17～18 设备 App、IMG-19～20 组合集成，IMG-21～24 目标云端及真机验收。
- 云资源部署、目标库连接/迁移和 Git 推送。

IMG-15 本地交付完成。G1/G2 仍为 PARTIAL，G3 获得 IMG-14/15 页面专项证据，仍为 PARTIAL，G4/G5 为 NOT_RUN。下一可执行任务为 IMG-16：告警详情与事件页面接入 evidenceImage，补齐无权限、未关联、AVAILABLE、DELETED、下载失败和清除后保留关联的界面与本地测试，继续复用现有媒体下载授权。
