# FE-04 Onboarding 审批页面

实现：[apps/admin-web/src/pages/onboarding](../../apps/admin-web/src/pages/onboarding/OnboardingReviewPanel.tsx)；测试：[apps/admin-web/test/onboarding.test.tsx](../../apps/admin-web/test/onboarding.test.tsx)。

## 交付状态（分层）

| 层级 | 状态 | 当前证据与边界 |
|---|---|---|
| module implemented | PASS | 列表/详情/审批、录入来源、证书流程状态、并发门控与敏感字段测试通过 |
| app integrated | PASS | 页面嵌入 `/devices/groups`，由组合根装载列表、详情和审批 API |
| browser verified | PASS | Chromium 验证审批双击幂等、录入来源、证书状态和响应式对话框 |
| target integrated | NOT RUN / NO RECEIPT | 未取得目标 Admin API、数据库迁移和证书 provisioning 联调凭据 |

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-04（P1 / 管理后台前端），依赖 FE-02、BE-ONB-02（均已交付） |
| 数据事实源 | BE-ONB-02：`listOnboardingRequests` / `getOnboardingRequest` / `approveOnboardingRequest` / `rejectOnboardingRequest`（If-Match 乐观锁；仅 PlatformSuperAdmin 可审批） |
| 原型区域 | index19.html“设备群管理 → 新增设备请求”；本面板由 FE-06 嵌入 `/devices/groups` |
| CT-06 与正式 API | BE-ONB-02 已提供 `submittedBy` 与不含私钥的 `certificateProvisioningStatus`；页面展示录入来源、申请日期和证书流程状态 |
| 功能边界 | 不代替设备领取证书包；页面不渲染 privateKey/Token 字段（契约显式排除，DOM 快照测试为 0） |

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `onboarding-api.ts` | 列表（状态筛选 + 游标分页）、详情、approve/reject（If-Match 携带 version，reject 强制 reason） |
| `onboarding-state.ts` | 状态文案（待审批/已通过/已拒绝）与 `isReviewable`（仅 PENDING 可审批） |
| `OnboardingReviewPanel.tsx` | 状态筛选 + 双向游标列表（序列号/型号/厂商/录入来源/申请日期/状态）+ 详情（含证书流程状态）+ 审批操作 |

## 3. 验收基准与证据（vitest + jsdom）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| PENDING/APPROVED/REJECTED 状态正确 | 状态列与筛选 Tabs 文案逐项断言；REJECTED 详情显示拒绝原因 | ✅ |
| 重复点击不会重复审批 | 在途期间按钮禁用 + `inFlight` 守卫直接忽略；后端 If-Match 兜底 | ✅ |
| 私钥关键词 DOM/网络快照为 0 | 列表、详情、approve/reject 原始请求与响应及 DOM 均检查 privateKey/token/PEM 等敏感标记 | ✅ |
| 拒绝原因必填 | ConfirmDialog requireReason：原因为空确认禁用，提交回传 reason | ✅ |
| 并发审批冲突可见 | 409 VERSION_CONFLICT → ErrorNotice “数据已被他人修改” + 刷新 | ✅ |
| 审批后跳转设备详情 | 批准成功 → `/devices/manage?serialNumber=…`（不伪造设备记录） | ✅ |
| 仅 SuperAdmin 显示操作 | `canReview=false` 或非 PENDING 时无批准/拒绝按钮（后端仍强制授权） | ✅ |

当前证据命令：`pnpm vitest run apps/admin-web/test/onboarding*.test.tsx`、`pnpm check:admin-web-e2e`、`pnpm verify`。浏览器 HTTP mock 与目标环境证据分层记录。

## 4. 对接说明

- **FE-06**：将 `OnboardingReviewPanel` 嵌入 `/devices/groups` 页面区域，列表/详情状态由页面层用 `fetchOnboardingRequests`/`fetchOnboardingRequest` 装载；
- **FE-07**：批准成功跳转 `/devices/manage?serialNumber=…`，设备管理详情页按序列号解析；
- 审批写操作由 BE-ONB-02 强制 `onboarding:approve` 与 If-Match，前端隐藏仅是体验层。

## 5. 未决风险

- 录入来源与证书流程状态已进入正式契约；展示值不含证书私钥或领取材料；
- 审批成功后列表项的移除/刷新策略由 FE-06 集成时统一（当前拒绝后自动刷新列表，批准后跳转离开）。
