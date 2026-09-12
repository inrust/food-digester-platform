# FE-14 Media 页面

实现：[apps/admin-web/src/pages/media](../../apps/admin-web/src/pages/media/MediaPage.tsx)；可复用组件：[MediaPreview](../../apps/admin-web/src/components/MediaPreview.tsx)；测试：[media.test.tsx](../../apps/admin-web/test/media.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-14（P2），依赖 FE-02、BE-MED-01（admin-media-api.json）、DEC-005、DEC-009、DEC-024 |
| 路由 | `/media`（扩展路由，CT-06 矩阵外，设备组菜单）；media:read = 全部五角色 |
| 数据 | 仅元数据列表（MediaView 不含 objectPath）+ 15 分钟预签名下载 URL（DEC-024，900s） |
| 租户隔离 | Customer 角色强制 actor.customerId（服务端）；跨 Customer 详情/下载 → 404；越权筛选 → 403 |
| DEC-005 | DELETED = 文件到期删除、元数据保留，不提供下载 |
| DEC-009 | 不提供实时流媒体会话；视频仅为录制文件的受控查看（无实时播放/停止语义） |

## 当前分层状态

| 层级 | 当前结论 | 证据边界 |
|---|---|---|
| module present | PASS | 页面、预览组件、API adapter 与定向测试存在。 |
| app integrated | PASS | `/media` 由正式 controller 接入组合根；筛选使用用户时区并拒绝倒置区间。 |
| browser verified | PASS | 本地 Chromium mock E2E 覆盖正式路由、续签与错误态；不证明真实 S3 短链。 |
| target integrated | NOT RUN / NO RECEIPT | 尚无真实 Cognito、已部署 API/S3 与精确提交回执。 |

当前整改依据：[FE-11 至 FE-15 全面复盘检查报告](../audit/FE-11至FE-15全面复盘检查报告-2026-09-12.md)。目标环境采集依据：[FE-11 至 FE-15 目标环境验收证据采集说明](../audit/evidence/FE-11至FE-15-目标环境验收证据采集说明.md)，发布时显式执行 `pnpm check:admin-web-fe11-15-target-evidence`。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `MediaPage`（/media） | 元数据列表（文件名/类型/设备/客户/采集时间/大小/时长/状态 + 游标分页）；类型/状态/设备/时间范围筛选（datetime-local → UTC ISO）；仅平台角色暴露 customerId 筛选；“刷新最新媒体”手动回源 |
| `MediaPreview`（可复用组件） | 受控查看：IMAGE → img、VIDEO → video（录制文件）；DELETED 提示元数据保留；未知类型安全降级（仅元数据，无 img/video/下载）；URL 过期提示 + 重新申请；错误可重试。供设备查看/操作页嵌入 |
| `media-state.ts` | 枚举文案（parity 锁定）、isDownloadUrlExpired（到期时刻 ≤ 当前即过期）、isKnownMediaType/mediaTypeLabel（安全降级）、localDateTimeToUtcIso、MEDIA_COVERAGE 锚点 |
| `media-api.ts` | listMedia（筛选 + 游标）、createMediaDownloadUrl（实时签发；调用方不得持久缓存） |

### 短期 URL 纪律

授权 URL 仅存于预览组件内存状态，关闭预览（Esc）即弃用；过期（≤当前时刻）显示“重新申请”，实时重签。测试断言重开预览必重新请求。

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 跨 Customer 资源不可访问 | 列表 403、下载 404、Customer 无 customerId 筛选 | 仓库内 PASS |
| 短链生命周期 | 过期后重新申请；关闭预览即弃用；不持久缓存 | 仓库内 PASS |
| 类型与预览边界 | 未知类型仅元数据；图片/录制视频受控查看；无实时流语义 | 仓库内 PASS |
| 筛选与时区 | 用户选择时区转换、倒置区间失败关闭、枚举 parity | 仓库内 PASS |
| CT-06 锚点 | 预览入口与覆盖矩阵 parity | 仓库内 PASS |

验证命令：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm check:admin-web-delivery`、`pnpm check:admin-web-e2e`。结果只支持前三层。

## 4. 未决风险

- 设备查看/操作页的“最新授权媒体”面板（FE-06/FE-12）当前仅元数据展示；如需内联受控预览可嵌入 `MediaPreview`（锚点已锁定，升级不改变 CT-06 语义）；
- 链接有效期 900s 为 DEC-024 冻结值；到期判定用客户端时钟，时钟漂移时以服务端 403/410 兜底；
- 列表 customerId 筛选仅平台角色可见，Customer 角色租户隔离完全依赖服务端（前端不做安全断言）。
- Owner：Release Engineering；关闭条件：真实跨租户拒绝、过期/续签短链、零持久化 URL 和清理回执通过独立 Gate；当前保持 NOT RUN / NO RECEIPT。
