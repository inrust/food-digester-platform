# IMG-16 留档图片页面与本地验收

2026-11-07，基于本地提交 `9d22a6ac557bf3ca6ad37ccfb4bfe7794992b722`（IMG-15）实施。进入时 main 工作区干净、已有 12 个未推送提交。本批按用户授权进行本地开发与检查，创建本地提交，不推送、不部署、不连接或迁移目标库。

依据：[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、[IMG-13 查询与权限验收](./IMG-13-图片证据查询与本地验收.md)、admin-alarm-api/admin-media-api 和 DEC-005/DEC-024。复用原媒体下载授权，不增加上传、签名或查询路由。实时预览链路不变。

## 完成情况与状态

告警详情增加留档图片区，业务事件列表增加留档图片列，防拆事件仍使用原只读视图。两处共用 EvidenceImageEntry，只有用户点击 AVAILABLE 入口后才申请签名链接和加载 JPEG。拍摄时间沿用 evidenceImage.captureTime，媒体 ID 直接来自该记录的关联，不按告警 code、设备或近似时间查找照片。

| 条件 | 页面状态与动作 |
|---|---|
| Session 无 media:read | 显示无读取权限，不显示关联元数据、图片或下载入口；即使旧记录含 evidenceImage 也不申请链接 |
| evidenceImage 省略 | 显示未提供图片信息；兼容旧响应与服务端省略字段，不把未知信息当成未关联 |
| evidenceImage=null | 显示尚未关联图片，不申请链接；不推断 PENDING、UNMATCHED、24 小时进度或必定能补齐 |
| AVAILABLE | 显示查看入口和拍摄时间；点击调用现有 GET /admin/media/{mediaId}/download-url，鉴权后显示图片及下载链接 |
| DELETED | 显示图片已删除、关联保留；不显示查看/下载入口，不申请签名链接 |
| 告警 ACTIVE / ACKNOWLEDGED / CLEARED | 读取入口只依据关联和读取权限。确认/清除写权限与图片读取分离；清除后刷新详情仍使用同一原始 mediaId |
| 下载签名 401/403 | 登录/权限失效提示，不展示图片、不自动重试；关闭后重新打开仍须经后端鉴权 |
| 下载签名 404 | 图片不可用或不在访问范围，提示刷新记录；不泄露具体跨租户对象，不误报已删除，不展示内部 message |
| 网络/503/超时 | 显示获取失败，用户可重新申请链接，无自动重试循环 |
| 对象 403/404、损坏图片或加载失败 | 浏览器图片 onError 清除图片和下载链接，显示加载失败，用户手动重新签名 |
| 下载 URL 到期 | 独立定时器清除图片和链接，显示过期；手动申请新链接，页面不靠下次请求触发过期 |
| 原记录迟到关联 | 新增页面刷新按钮，回源列表及当前告警详情；从 null 到 AVAILABLE 后出现入口，刷新本身不自动签名 |

请求最多等待 12 秒，AbortSignal 取消；传输忽略取消时也通过 promise race 退出等待。URL 只接受同 mediaId、合法截止时间、无用户名密码的 HTTPS 链接；过期响应不展示，页面最多保留 900 秒。签名期限仍由后端 DEC-024 决定，客户端上限不是新签名权限。

关闭时立即取消并丢弃内存中的链接；重新打开重新签名。切换源记录、关联、AVAILABLE/DELETED、拍摄时间或客户端读取权限会销毁旧实例，迟到结果不能重新打开图片。组件卸载取消请求、清理期限和 watchdog。底层签名适配器新增可选 signal/no-store；不传 signal 的既有媒体页调用保持原有请求参数。

控制器按 username/customerId/roles 重建状态，避免身份或租户切换沿用旧列表、详情和图片；筛选或 Tab 变化关闭旧详情。同一记录多次读取和每类列表请求使用代次，后返回的旧响应不能覆盖新的 DELETED/null 或当前筛选结果。这是页面可见性防护，源记录与媒体的权威租户/读取授权仍由后端执行。

已取得的图片和 URL 只在页面内存/必要 DOM 中使用，关闭、失败或到期后移除。不写 localStorage/sessionStorage，不打印 Base64、签名 URL 或服务端内部 message。img 和下载链接使用 no-referrer。页面清理不代表撤销已经签发的 S3 授权，真实 URL 撤权与保留策略边界仍需目标环境验证。

## 修改文件

| 文件 | 内容 |
|---|---|
| `apps/admin-web/src/pages/alarms/EvidenceImageEntry.tsx` | 共用留档入口、按需签名、加载/错误/重签/关闭/过期、取消和迟到隔离 |
| `apps/admin-web/src/pages/alarms/AlarmsPage.tsx` | 告警详情与事件行接入、页面刷新；清除状态不禁用读取 |
| `apps/admin-web/src/pages/alarms/types.ts` | AlarmView/DeviceEventView 复用已生成契约类型，保留 evidenceImage 的可选/null 语义 |
| `apps/admin-web/src/pages/media/media-api.ts` | 复用签名 API，可选 signal/no-store，旧调用兼容 |
| `apps/admin-web/src/app/feature-controllers.tsx` | 真实装配、任一角色 media:read 粗筛、身份范围重建、列表和详情代次 |
| `apps/admin-web/src/app/app.css`、`i18n/resources/en.ts`、`zh-CN.ts` | 受限尺寸图片/移动换行及中英文状态 |
| `apps/admin-web/test/evidence-image.test.tsx` | 状态矩阵、权限、链接/对象失败、超时、期限、关闭/换源/删除/撤权后迟到结果 |
| `apps/admin-web/test/evidence-controller.test.tsx` | 生产控制器清除后查看、租户切换、同记录与筛选竞争、刷新发现迟到关联 |
| `apps/admin-web/test/alarms.test.tsx`、`media.test.tsx`、`i18n.test.tsx` | 页面接入、状态与签名兼容、26 个页面 TSX 扫描和键集合一致 |
| `apps/admin-web/e2e/evidence-image.spec.ts` | 桌面英文/移动中文清除后原图、事件未关联/省略/删除、签名/对象失败与重试、403/404 |
| 本文、开发计划、IMG-04 补充 | 进度、检查、历史失败和 NOT_RUN |

## 本地检查

使用 Node 24.22.1、`/opt/homebrew/bin/pnpm` 10.20.0。命令在仓库根执行，临时日志位于 `/tmp/img16-*.log`，不作为云端验收或真机证据。

| 检查 | 结果 |
|---|---|
| `pnpm exec vitest run --maxWorkers=4` | PASS，218 文件、2148 项（最终源码） |
| evidence-image/evidence-controller/alarms/media/i18n 专项 | PASS，5 文件、64 项 |
| `pnpm --filter @fdp/admin-web... typecheck` | PASS，含依赖和 e2e TypeScript |
| `pnpm --filter @fdp/admin-web exec playwright test e2e/evidence-image.spec.ts e2e/live-image-preview.spec.ts e2e/live-image-recovery.spec.ts` | PASS，9 项；构建通过，保留 WARN |
| `pnpm test:contracts` | PASS，319 项 |
| `pnpm openapi:check` | PASS，bundle 新鲜度与 Redocly |
| `node --import tsx --test scripts/check-delivered-runtime.test.mjs scripts/check-migrations.test.mjs scripts/check-cdk-synth.test.mjs` | PASS，17 项 |
| admin-web-delivery / delivered-runtime | PASS，生产路由与 OpenAPI 一致，134 operations |
| boundaries / sensitive-sinks / secrets / migrations | PASS，无新包边界、敏感输出或迁移漂移 |
| 离线 `node scripts/check-cdk-synth.mjs` | PASS，无 warning；禁用凭据/元数据查询，固定合成 account/region，未部署 |
| 本批 ESLint / 支持文件 Prettier / `git diff --check` | PASS；docs 按 .prettierignore 排除，另检查内容和本地链接 |

浏览器仅使用本地 Vite、模拟 API 和被拦截的 HTTPS 对象请求，qa05 防护阻止未拦截 API/外部请求；没有生产凭据或实际 S3 访问。IMG-16 三项与 IMG-14/15 六项一起验证，不以新功能替代既有预览回归。

已查看 `/tmp/fdp-img16-alarm-1440.png`、`/tmp/fdp-img16-alarm-375.png`、`/tmp/fdp-img16-denied.png`，中英文状态、关闭/重试/下载入口与移动边界正常。fixture 是可校验的小 JPEG，验证真实解码和容器行为，不冒充真实设备拍摄质量。截图只为本地临时附件，不混入源码。

### FAIL / 修复记录

- 首轮 29 PASS / 1 FAIL：i18n 扫描固定为 25 个页面 TSX，共用留档组件加入后实际为 26。更新精确模块数，仍扫描全 UI 源码并检查语言键，未删除约束。
- 控制器初轮 58 PASS / 3 FAIL：测试在 act 中等待 findBy，阻塞了待刷新的初始列表提交；将查找放在 act 外，再执行点击。修复后控制器 3 PASS / 1 FAIL：清除测试使用 CustomerViewer，没有 alarm:write，按钮按既有规则正确禁用。测试改用有写权限的 PlatformOperator，未修改权限矩阵或放开业务按钮。
- 后续定向测试通过，并补齐生产控制器装配、同记录竞争和人工刷新断言。原告警、媒体、i18n 约束保留。

最终未解决 FAIL=0、BLOCKED=0。历史失败保留，不将 NOT_RUN 转为 PASS。

### WARN

保留 Vite 超过 500kB 的分块提示，以及 Playwright 子进程 NO_COLOR/FORCE_COLOR 提示。没有屏蔽警告、放宽门槛或扩大为打包重构。

### NOT_RUN

- 真实 Cognito/API Gateway/RBAC、真实客户归属切换和权限撤销传播；本地权限分支与 mock 不是公开入口验收。
- 实际 S3 下载签名、对象保留/删除、缓存、响应头和 CORS/CSP；未验证已签发 URL 的真实撤权边界。
- 真实 DynamoDB/PostgreSQL/Outbox/MQTT 与事件/告警乱序上传及真实关联流程。前端 mock 中更新关联不证明归档端到端完成。
- Firefox/Safari/Edge、真实移动设备/系统挂起/强杀、严重客户端时钟偏差和真实照片网络加载性能。
- 完整历史 Playwright、全仓 `pnpm verify`、IMG-19/20 组合集成和正式 G3 Gate；本批只执行列出的门禁及九项页面专项。
- IMG-17/18 厨房 App、IMG-21～24 真实云端/真机验收。仍待设备方 App 代码仓库/版本、真实拍照触发办法、业务白名单、启用规模/并发规模、首帧等待目标和联调环境。
- 云资源部署、目标库连接/迁移、Git 推送。

IMG-16 本地交付完成；G1/G2 与 G3 继续为 PARTIAL，G3 新增平台 IMG-14～16 页面证据，G4/G5 仍为 NOT_RUN。下一执行项 IMG-17 为厨房 App 的能力启用、5 秒 state 查询、2 秒采样上传和停止逻辑；设备方 App 由外部交付，应先取得对应仓库/版本及对接输入，不把本仓库的模拟用例记为 App 已实现。
