# FE-13 OTA 页面（固件包 + OTA Campaign）

实现：[apps/admin-web/src/pages/ota](../../apps/admin-web/src/pages/ota/OtaCampaignsPage.tsx)；测试：[ota.test.tsx](../../apps/admin-web/test/ota.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-13（P2），依赖 FE-02、BE-OTA-01（admin-ota-package-api.json）、BE-OTA-02/03（admin-ota-campaign-api.json） |
| 路由 | `/ota/campaigns`（FE-01 已注册，CT-06 矩阵内子页）+ `/ota/packages`（扩展路由）；角色 = ota:read 持有者（PlatformSuperAdmin/PlatformOperator/Auditor） |
| 包状态机 | UPLOADED（会话已建，未完成校验）→ VERIFIED（可发布，不可变）；可发布列表 = status VERIFIED |
| Campaign 状态机 | 创建即 RUNNING；RUNNING⇄PAUSED；RUNNING/PAUSED→CANCELLED（级联未完成 target）；全部 SUCCEEDED→COMPLETED |
| 灰度纪律 | 首批强制恰好 1 台（契约 maxItems:1）；扩大批次默认禁止一次选择全部合格设备；strategy 仅 CANARY（禁止默认全量强制升级） |

### 原型映射纪律

- 概览设备卡片“升级”（FE-03 预埋）与设备管理“同步更新”均跳转 `/ota/campaigns` 创建受控 Campaign，**禁止直接向单设备推送未校验文件**；设备管理“选择固件文件”跳转 `/ota/packages` 上传；
- CT-06 锚点双向锁定：`dashboard.button.upgrade` / `device-manage.button.selectFirmware` / `device-manage.button.syncUpdate`（parity 精确集合比对）。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `OtaPackagesPage`（/ota/packages） | 上传会话表单（model/version/packageType/sizeBytes/sha256/signature 字段级校验，镜像契约 pattern 与 512MiB 上限）→ 会话面板（objectKey 服务端生成、预签名 URL 过期时间）→ “已完成直传，提交校验”→ VERIFIED；包列表（model/version/packageType/status 筛选 + 游标分页，VERIFIED 标“可发布”徽标） |
| `OtaCampaignsPage`（/ota/campaigns） | Campaign 列表（status/targetModel 筛选 + 游标分页）；创建表单（名称 ≤128、VERIFIED 包下拉、首批单设备选择）；详情看板（targetCounts 总计 + 8 状态计数）；目标列表（status/batchNo 筛选）；动作按钮按矩阵（暂停/恢复/取消/扩大批次/失败重试，禁用附原因） |
| `ota-state.ts` | 状态枚举/文案、CAMPAIGN_ACTION_MATRIX、gateCampaignAction（ota:write ∩ 矩阵）、validateUploadMetadata、validateCampaignCreate（VERIFIED 集合 + 恰好 1 台）、validateBatchExpand（禁全选）、OTA_COVERAGE 锚点表 |
| `ota-api.ts` | createFirmwareUpload/completeFirmwareUpload/listFirmwarePackages/getFirmwarePackage；createOtaCampaign（首批 ≠1 台装配层直接拒绝，不发请求）/listOtaCampaigns/getOtaCampaign/listOtaTargets/expandOtaCampaignBatch（全选守卫）/pause/resume/cancel/retry（子集 targetIds 可选） |
| DeviceManagePage | 新增 OTA 入口区（goto-ota-packages / goto-ota-campaigns）；无 ota:read 角色不展示入口 |

### 上传直传边界

页面不持有对象存储密钥、不生成上传 URL：创建会话返回的预签名 URL（900s 暂定）由容器经 `onUploadAndComplete` 装配浏览器直传 + complete 校验；详情不展示预签名 URL/信任根材料。

## 3. 验收基准与证据（vitest + jsdom，15 例 + parity 2 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 坏包不可建 Campaign | 包下拉仅 VERIFIED 选项；无可发布包时创建入口禁用；validateCampaignCreate 拒绝非 VERIFIED packageId | ✅ |
| 首批 >1 台前端阻止且后端拒绝 | validateCampaignCreate（0/2 台均拒绝）；createOtaCampaign 装配层守卫（throw 且不发请求；服务端 400 兜底） | ✅ |
| 暂停后状态正确 | RUNNING→暂停→“已暂停/不再产生新下发”；PAUSED→恢复；取消经危险确认 + 级联取消提示；终态全部动作禁用 | ✅ |
| 扩大批次禁全选 | 全选 2/2 → 前端阻止 + 提交禁用；部分选择提交（addedCount/幂等跳过提示）；装配层守卫 | ✅ |
| 失败重试 | FAILED 列表勾选子集携 targetIds；缺省重试全部（无 body） | ✅ |
| 目标状态看板 | total + 8 状态计数渲染；目标列表批次（1=灰度）/状态/筛选回调 | ✅ |
| 上传直传 S3 | 会话创建 → 直传+complete 回调携会话 → VERIFIED 提示 + 回源刷新；字段级校验 | ✅ |
| 权限 | Auditor 只读（上传/动作禁用 + ota:write 原因）；CustomerAdmin 无 OTA 入口 | ✅ |
| CT-06 锚点 | OTA 元素 ⇄ OTA_COVERAGE 精确一致；枚举与矩阵 parity | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。

## 4. 未决风险

- **失败原因按设备展示无 API 来源**：OtaTargetView 无 failureReason 字段（BE-OTA-02 契约冻结），页面以看板计数 + 目标状态呈现失败，明细失败原因需契约补充字段（当前可经告警与事件页追溯）；建议单开契约演进任务；
- 预签名 URL 有效期 900s 为暂定值，过期需重建会话（页面已提示）；签名格式由 ota-package-signature-policy 冻结值驱动，冻结前 complete 失败关闭（409）；
- 合格设备集合（型号匹配 + Active/Maintenance + OTA_UPDATE Entitlement）由容器装配注入，页面不重复判定（后端 VALIDATION_FAILED 最终裁决）；
- 既有 Gate 问题（与 FE 工作无关）：`openapi:check`/`test:scripts` 因 prototype-planned-api.json operationId 重复失败（FE-01 已报告，建议单开修复任务）。
