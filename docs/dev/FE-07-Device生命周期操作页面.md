# FE-07 Device 生命周期操作页面

实现：[apps/admin-web/src/pages/device-manage](../../apps/admin-web/src/pages/device-manage/DeviceManagePage.tsx)；测试：[device-manage.test.tsx](../../apps/admin-web/test/device-manage.test.tsx)。

## 0. 交付状态

| 层级 | 当前状态 | 可复核证据 |
|---|---|---|
| module present | **PASS** | 生命周期、Assignment、退役、Alias 与证书轮换模块存在；`pnpm --filter @fdp/admin-web typecheck` |
| app integrated | **PASS** | `/devices/manage` 已接入组合根和交付清单；`pnpm check:admin-web-delivery` |
| browser verified | **PASS（本地）** | Chromium 覆盖真实路由、失败状态、详情焦点和重复提交；`pnpm check:admin-web-e2e` |
| target integrated | **NOT RUN / NO RECEIPT** | 尚无当前提交对应的真实 Cognito/部署后 API/IoT 处置回执；`pnpm check:admin-web-target-evidence` 当前应失败关闭 |

整改依据：[FE-06至FE-10 全面复盘检查报告](../audit/FE-06至FE-10全面复盘检查报告-2026-09-10.md)；目标回执规则：[FE-06～FE-10 目标环境验收证据采集说明](../audit/evidence/FE-06至FE-10-目标环境验收证据采集说明.md)。

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

- `getDevice` 返回退役摘要；页面每次加载和操作后均回源恢复 `PENDING_CONFIRMATION`/`CONFIRMED` 状态，不依赖会话内响应。
- CT-06 device-manage 页其余元素（更新配置/查看配置/固件/同步更新属 BE-CFG-01/BE-OTA-01 → FE-09/FE-13）不在本任务范围，parity 测试仅锁定 FE-07 自有元素（返回按钮）。
- 页面不直接修改状态字段：所有操作成功后经 `onRefresh` 回源（getDevice + assignments），无本地状态伪造。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `DeviceManagePage`（/devices/manage） | 生命周期动作、Assignment、可回源退役面板；Alias 按 trim/NFC 与 Unicode code point 1..64 校验；证书摘要和轮换请求 |
| `device-manage-state.ts` | LIFECYCLE_ACTION_MATRIX、gateAction（矩阵 ∩ 角色 ∩ DOM-01 特例 ∩ 证书 ACTIVE）、canForceComplete、展示文案、CT-06 锚点表 |
| `device-manage-api.ts` | assignDevice/fetchDeviceAssignments/suspendDevice/reactivateDevice/retireDevice/forceCompleteRetirement/updateDeviceAlias（If-Match=updatedAt）/requestCertificateRotation |
| `types.ts` | Assignment/Retirement/Metadata/Rotation 视图类型（逐字段镜像契约） |

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 状态与权限矩阵 | 合法动作可见；非法或无权限动作禁用并说明原因 | **LOCAL PASS** |
| 后端拒绝呈现 | 403、状态冲突和 Alias 版本冲突可区分 | **LOCAL PASS** |
| 危险操作与刷新 | 原因/确认必填，成功后回源 | **LOCAL PASS** |
| 退役跨会话恢复 | getDevice 退役摘要恢复等待和完成状态 | **LOCAL PASS** |
| Alias 契约 | trim/NFC/code point、If-Match 与清除语义 | **LOCAL PASS** |
| 证书零私钥 | 仅摘要与轮换请求，不出现私钥或下载入口 | **LOCAL PASS** |

仓库内证据命令：`pnpm exec vitest run apps/admin-web/test/device-manage.test.tsx apps/admin-web/test/contract-parity.test.ts`、`pnpm check:admin-web-delivery`、`pnpm check:admin-web-e2e`、`pnpm verify`。

## 4. 可追踪问题

| ID | 状态 | Owner | 关闭条件 | 验证命令 |
|---|---|---|---|---|
| FE07-CERT-01 | **OPEN / CONTRACT GAP** | BE-CERT owner | 若要求轮换历史，增加受权查询契约和页面时间线；当前仅展示请求结果并由 getDevice 证书摘要反映最终状态 | `rg -n "rotation" contracts/rest/admin-certificate-rotation-api.json` |
| FE07-TARGET-01 | **NOT RUN / NO RECEIPT** | Release QA | 隔离环境证明危险操作、退役窗口、IoT 处置和跨租户拒绝，绑定精确 HEAD 并清理 | `pnpm check:admin-web-target-evidence` |

Assignment 的可选 reason 和幂等重放属于正式契约行为，不作为未决缺陷。
