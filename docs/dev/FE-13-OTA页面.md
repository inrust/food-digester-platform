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

## 当前分层状态

| 层级 | 当前结论 | 证据边界 |
|---|---|---|
| module present | PASS | 页面、API adapter、OTA 状态逻辑、契约与定向测试存在。 |
| app integrated | PASS | 两个 OTA 路由由正式 controller 接入组合根；失败码和脱敏原因已贯通数据库、服务与 OpenAPI。 |
| browser verified | PASS | 本地 Chromium mock E2E 覆盖正式路由与 Campaign 交互；不证明真实 S3/IoT。 |
| target integrated | NOT RUN / NO RECEIPT | 尚无真实 Cognito、S3、IoT、已部署 API 与精确提交回执。 |

当前整改依据：[FE-11 至 FE-15 全面复盘检查报告](../audit/FE-11至FE-15全面复盘检查报告-2026-09-12.md)。目标环境采集依据：[FE-11 至 FE-15 目标环境验收证据采集说明](../audit/evidence/FE-11至FE-15-目标环境验收证据采集说明.md)，发布时显式执行 `pnpm check:admin-web-fe11-15-target-evidence`。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `OtaPackagesPage`（/ota/packages） | 上传会话表单（model/version/packageType/sizeBytes/sha256/signature 字段级校验，镜像契约 pattern 与 512MiB 上限）→ 会话面板（objectKey 服务端生成、预签名 URL 过期时间）→ “已完成直传，提交校验”→ VERIFIED；包列表（model/version/packageType/status 筛选 + 游标分页，VERIFIED 标“可发布”徽标） |
| `OtaCampaignsPage`（/ota/campaigns） | Campaign 列表（status/targetModel 筛选 + 游标分页）；创建表单（名称 ≤128、VERIFIED 包下拉、首批单设备选择）；详情看板（targetCounts 总计 + 8 状态计数）；目标列表（status/batchNo 筛选）；动作按钮按矩阵（暂停/恢复/取消/扩大批次/失败重试，禁用附原因） |
| `ota-state.ts` | 状态枚举/文案、CAMPAIGN_ACTION_MATRIX、gateCampaignAction（ota:write ∩ 矩阵）、validateUploadMetadata、validateCampaignCreate（VERIFIED 集合 + 恰好 1 台）、validateBatchExpand（禁全选）、OTA_COVERAGE 锚点表 |
| `ota-api.ts` | createFirmwareUpload/completeFirmwareUpload/listFirmwarePackages/getFirmwarePackage；createOtaCampaign（首批 ≠1 台装配层直接拒绝，不发请求）/listOtaCampaigns/getOtaCampaign/listOtaTargets/expandOtaCampaignBatch（全选守卫）/pause/resume/cancel/retry（子集 targetIds 可选） |
| DeviceManagePage | 新增 OTA 入口区（goto-ota-packages / goto-ota-campaigns）；无 ota:read 角色不展示入口 |

### 上传直传边界

页面不持有对象存储密钥、不生成上传 URL：创建会话返回的预签名 URL（900s，DEC-024@1.0.0）由容器经 `onUploadAndComplete` 装配浏览器直传 + complete 校验；详情不展示预签名 URL/信任根材料。

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 坏包与灰度边界 | 仅 VERIFIED 包可选；首批恰好一台；非法输入前后端均拒绝 | 仓库内 PASS |
| Campaign 状态与扩批 | 暂停/恢复/取消/扩批/重试及终态动作矩阵 | 仓库内 PASS |
| 失败明细 | 目标结构化失败码与脱敏原因贯通数据库、服务、OpenAPI 和页面；重试清除旧值 | 仓库内 PASS |
| 上传直传 | 会话创建、浏览器直传回调、complete 校验与回源刷新 | 仓库内 PASS |
| 权限与锚点 | Auditor 只读、Customer 无入口；页面元素与契约 parity | 仓库内 PASS |

验证命令：`pnpm lint`、`pnpm typecheck`、`pnpm openapi:check`、`pnpm test`、`pnpm check:migrations`、`pnpm check:admin-web-e2e`。结果只支持前三层。

## 4. 未决风险

- 预签名 URL 有效期 900s 由 DEC-024@1.0.0 冻结，过期需重建会话（页面已提示）；签名格式由 ota-package-signature-policy 驱动，complete 失败关闭（409）；
- 合格设备集合（型号匹配 + Active/Maintenance + OTA_UPDATE Entitlement）由容器装配注入，页面不重复判定（后端 VALIDATION_FAILED 最终裁决）；
- Owner：Release Engineering；关闭条件：真实 S3/IoT/Cognito 闭环、失败明细脱敏与清理回执通过独立 Gate；当前保持 NOT RUN / NO RECEIPT。
