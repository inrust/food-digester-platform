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

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `MediaPage`（/media） | 元数据列表（文件名/类型/设备/客户/采集时间/大小/时长/状态 + 游标分页）；类型/状态/设备/时间范围筛选（datetime-local → UTC ISO）；仅平台角色暴露 customerId 筛选；“刷新最新媒体”手动回源 |
| `MediaPreview`（可复用组件） | 受控查看：IMAGE → img、VIDEO → video（录制文件）；DELETED 提示元数据保留；未知类型安全降级（仅元数据，无 img/video/下载）；URL 过期提示 + 重新申请；错误可重试。供设备查看/操作页嵌入 |
| `media-state.ts` | 枚举文案（parity 锁定）、isDownloadUrlExpired（到期时刻 ≤ 当前即过期）、isKnownMediaType/mediaTypeLabel（安全降级）、localDateTimeToUtcIso、MEDIA_COVERAGE 锚点 |
| `media-api.ts` | listMedia（筛选 + 游标）、createMediaDownloadUrl（实时签发；调用方不得持久缓存） |

### 短期 URL 纪律

授权 URL 仅存于预览组件内存状态，关闭预览（Esc）即弃用；过期（≤当前时刻）显示“重新申请”，实时重签。测试断言重开预览必重新请求。

## 3. 验收基准与证据（vitest + jsdom，12 例 + parity 1 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 跨 Customer 资源不可访问 | 列表 403 → 无权界面（含 requestId）；下载 404 → 错误可读 + 可重新申请；Customer 角色无 customerId 筛选框 | ✅ |
| 链接过期后重新申请 | 注入时钟：过期提示 → 重新申请 → 二次签发；关闭预览即弃用（重开必重签） | ✅ |
| 未知媒体类型安全降级 | mediaType 越界（如 AUDIO）→ 仅元数据，无 img/video/下载链接，文案“未知类型” | ✅ |
| 受控图片/视频查看 | IMAGE → img + 下载链接 + 有效期提示；VIDEO → video（controls）；页面无实时画面/直播/RTSP 字样与播放/停止按钮 | ✅ |
| 元数据列表与筛选 | 类型/状态/设备/客户/时间筛选回调（时间转 UTC ISO）；时长列（图片 —）；DELETED 行无操作 | ✅ |
| CT-06 锚点 | device-view.field.mediaPreview ⇄ MEDIA_COVERAGE 精确一致；枚举 parity | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。

## 4. 未决风险

- 设备查看/操作页的“最新授权媒体”面板（FE-06/FE-12）当前仅元数据展示；如需内联受控预览可嵌入 `MediaPreview`（锚点已锁定，升级不改变 CT-06 语义）；
- 链接有效期 900s 为 DEC-024 冻结值；到期判定用客户端时钟，时钟漂移时以服务端 403/410 兜底；
- 列表 customerId 筛选仅平台角色可见，Customer 角色租户隔离完全依赖服务端（前端不做安全断言）。
