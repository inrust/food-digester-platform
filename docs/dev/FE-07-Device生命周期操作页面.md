# FE-07 Device 生命周期操作页面

实现：[apps/admin-web/src/pages/device-manage](../../apps/admin-web/src/pages/device-manage/DeviceManagePage.tsx)；测试：[device-manage.test.tsx](../../apps/admin-web/test/device-manage.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-07（P1），依赖 FE-06、BE-DEV-02/03/04/06（契约均已交付）；证书轮换 BE-CERT-03 契约与后端已实现，按 P2 语义启用“请求轮换” |
| 路由 | `/devices/manage`（FE-01 注册，pageState `device-manage`，parentPath `/devices/groups`） |
| Assignment | BE-DEV-02：POST `/devices/{id}/assignment`（siteId 必须属于 customerId）+ GET `…/assignments`（倒序上限 50） |
| Suspend/Reactivate | BE-DEV-03：强制原因；reactivate 携 `issueResolved=true`；无 If-Match |
| Retire | BE-DEV-04 + DEC-014：携 `confirm=true`；Retired 不可恢复；72 小时确认窗口内证书保持 ACTIVE 且仅允许 Sync/Deactivate；force-complete 仅 Retired + PENDING_CONFIRMATION |
| 别名 | BE-DEV-06：PATCH `…/metadata`，V1 白名单仅 alias；**If-Match 头携带设备当前 updatedAt（ISO8601）**，409 VERSION_CONFLICT 提示刷新 |
| 证书 | getDevice 的 `certificate` 摘要（ID/指纹/状态，不含 PEM/私钥）；BE-CERT-03 轮换仅创建请求，管理端不生成/下载私钥 |

### 状态矩阵（LIFECYCLE_ACTION_MATRIX，device-manage-state.ts）

| 生命周期 | 合法动作 |
|---|---|
| PendingOnboarding / Rejected / OnboardingApproved | 仅改别名 |
| Onboarded / Assigned | 分配、改别名、请求轮换（Onboarded 首次分配仅 SuperAdmin，DOM-01） |
| Licensed | 改别名、请求轮换 |
| Active | 挂起、退役、改别名、请求轮换 |
| Suspended | 恢复、退役、改别名、请求轮换 |
| Retired | 仅改别名；PENDING_CONFIRMATION 时 SuperAdmin 可强制完成 |

权限门（AUTH-01 + DOM-01）：assign=`device:assign`；suspend/reactivate/alias=`device:write`；retire/force-complete=仅 PlatformSuperAdmin；轮换=`certificate:rotate`（矩阵唯一持有者 SuperAdmin）。前端仅做体验层门控，授权唯一可信来源是后端。

### 边界说明

- 退役记录无 GET 来源：页面展示的退役记录来自 retire/force-complete 响应；刷新后若设备已 Retired 但无会话内记录，仅展示“已退役（不可恢复）”，不伪造确认状态。
- CT-06 device-manage 页其余元素（更新配置/查看配置/固件/同步更新属 BE-CFG-01/BE-OTA-01 → FE-09/FE-13）不在本任务范围，parity 测试仅锁定 FE-07 自有元素（返回按钮）。
- 页面不直接修改状态字段：所有操作成功后经 `onRefresh` 回源（getDevice + assignments），无本地状态伪造。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `DeviceManagePage`（/devices/manage） | 设备头（别名/序列号/四轴徽标）+ 返回；生命周期操作按钮组（矩阵 ∩ 角色门控，禁用附原因 title）；分配对话框（客户→站点联动过滤、原因可选）；挂起/恢复/退役/强制完成确认框（原因必填）；退役面板（状态/窗口语义/完成方式/撤证时间）；别名编辑（1..64 校验、清除=null）；证书摘要 + 请求轮换；Assignment 历史表 |
| `device-manage-state.ts` | LIFECYCLE_ACTION_MATRIX、gateAction（矩阵 ∩ 角色 ∩ DOM-01 特例 ∩ 证书 ACTIVE）、canForceComplete、展示文案、CT-06 锚点表 |
| `device-manage-api.ts` | assignDevice/fetchDeviceAssignments/suspendDevice/reactivateDevice/retireDevice/forceCompleteRetirement/updateDeviceAlias（If-Match=updatedAt）/requestCertificateRotation |
| `types.ts` | Assignment/Retirement/Metadata/Rotation 视图类型（逐字段镜像契约） |

## 3. 验收基准与证据（vitest + jsdom，26 例 + parity 1 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 状态矩阵 UI 测试通过 | Active/Suspended/Onboarded/Assigned/Retired × SuperAdmin/Operator/Auditor/Customer 角色的按钮可用性矩阵断言（含禁用原因 title） | ✅ |
| 非法操作按钮不可用 | 状态不允许或角色无权限时按钮 disabled 且提示原因 | ✅ |
| 后端拒绝仍正确呈现 | 409 DEVICE_STATE_NOT_ALLOWED → 错误码+message 展示；403 → 无权提示；409 VERSION_CONFLICT（alias）→ 提示刷新 | ✅ |
| 操作后历史刷新 | 挂起/恢复/退役/分配/改名/轮换成功后均调用 onRefresh 回源 | ✅ |
| 危险操作原因+确认 | suspend/reactivate/retire/force-complete 原因必填（空原因确认禁用）；retire 对话框含“不可恢复”与 72 小时窗口警告 | ✅ |
| Retire 等待设备确认状态 | PENDING_CONFIRMATION → “等待设备确认”+ 72 小时窗口语义；CONFIRMED 展示完成方式/撤证时间；强制完成仅 SuperAdmin + PENDING 可用 | ✅ |
| Alias If-Match | API 装配测试：PATCH 携 `If-Match: <updatedAt>`；reactivate 携 issueResolved=true；retire 携 confirm=true | ✅ |
| 证书无私钥 | 页面全文负向断言 privateKey/PRIVATE KEY/下载证书；证书区仅 ID/指纹/状态；轮换按钮为“请求轮换” | ✅ |
| CT-06 锚点 | device-manage 页 FE-07 自有元素 100% 覆盖且覆盖表无多余键 | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。任务文档不固化易漂移计数。

## 4. 未决风险

- 退役记录无 GET 端点：跨会话无法回填确认状态（仅“已退役”兜底文案）；若验收要求跨会话可见，需 BE-DEV-04 增加查询接口；
- assign 请求体 reason 为可选（契约）；分配对话框预填当前归属，重复提交由后端幂等（replayed=true）兜底；
- 轮换结果仅展示最近一次响应（无列表查询接口）；轮换完成进度需设备侧回写后由 getDevice 证书状态反映。
