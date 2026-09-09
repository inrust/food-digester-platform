# FE-12 Remote Command 页面（操作设备）

实现：[apps/admin-web/src/pages/device-operate](../../apps/admin-web/src/pages/device-operate/DeviceOperatePage.tsx)；测试：[device-operate.test.tsx](../../apps/admin-web/test/device-operate.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-12（P1），依赖 FE-02、BE-CMD-01/03（admin-command-api.json）、BE-CFG-01、BE-DEV-05（admin-device-console-api.json）、DEC-009 |
| 路由 | `/devices/operate`（CT-06 矩阵内菜单，PlatformSuperAdmin/PlatformOperator/CustomerAdmin） |
| 命令目录 | CT-04（contracts/mqtt/command-catalog.json，22 个）前端镜像逐条 parity 锁定；命令名集合与 admin-command-api CommandName 枚举一致 |
| 高风险确认 | 请求仅提交 confirmText 且必须与命令名完全一致；服务端以已验签 JWT auth_time 校验近期重新认证（DEC-023） |
| 幂等 | meta.id 即 commandId（DEC-006）；replayed=true 提示“幂等重放无新写入” |
| DEC-009 | 媒体面板仅最新 Media 元数据 + 手动刷新；无播放/停止/视频元素（DOM 负向断言） |

### 原型映射纪律

- 8 快捷动作 → CT-04 正式命令：搅拌正/反转（AGITATOR_FORWARD/REVERSE）、加热（HEATING_ON/OFF 组）、排气（EXHAUST_ON/OFF 组）、重启（REBOOT）、关机（SHUTDOWN）、模式切换（MACHINE 组 START/STOP/PAUSE/RESUME/EMERGENCY_STOP，表单内选定真实命令）、恢复出厂（FACTORY_RESET）；按钮文案附带 command code（可追溯）；
- **M/N（搅拌间隔/时长）与温度阈值不产生命令**：跳转 `/configurations` 版本发布（FE-09），测试断言无命令提交；
- 未知命令 code 在类型层与运行时（commandSpecOf 抛错）双重禁止。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `DeviceOperatePage`（/devices/operate） | ScopeFilter 联动选设备；当前运行状态（四轴徽标）；快捷操作 + 配置跳转；命令表单（命令白名单下拉、timeoutSec 1~3600、remarks ≤500、高风险确认凭证输入）；命令状态列表（状态/命令筛选 + 游标分页）；命令详情（attempts/acks 时间线、**迟到 ACK** 标注）；操作日志（级别/类型筛选 + 异步 CSV 导出）；最新媒体面板 |
| `command-state.ts` | COMMAND_CATALOG（CT-04 镜像）、COMMAND_LABELS、QUICK_ACTIONS 映射、gateCommand（command:send ∩ 运行状态轴 ∩ 在线 ∩ REMOTE_CONTROL）、状态/ACK/日志文案、isLateAck、CT-06 锚点表 |
| `commands-api.ts` | createDeviceCommand（不含 requestedBy）/fetchCommands/fetchCommand/fetchDeviceActivities/createActivityExport/fetchActivityExport |

### 顺带修复（组件缺陷）

`Modal` 的 focus effect 依赖内联 `onClose` 导致每次父级渲染重新聚焦对话框、吞掉后续键盘输入（页面级表单状态时必现）。修复为 `onCloseRef` 持有 + effect 仅依赖 `open`（Esc 与焦点回收语义不变，既有测试全绿）。

## 3. 验收基准与证据（vitest + jsdom，12 例 + parity 1 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 22 命令与 8 快捷动作映射正确 | 目录 22 条与 CT-04 逐条一致（parity）；QUICK_ACTIONS 映射断言（直接 code/命令组均在目录内） | ✅ |
| 不存在无协议 command code 的提交 | commandSpecOf('MODE_SWITCH') 抛错；模式切换表单下拉仅组内真实命令；提交体 command ∈ 目录 | ✅ |
| 高风险无确认不能提交 | confirmText 不一致/为空 → 提交禁用；精确一致 → 仅提交 confirmation{confirmText}；认证时间不接受客户端声明 | ✅ |
| 配置更新不误走命令 API | goto-config-strategy/threshold → onNavigate('/configurations') 且 submitted 为空 | ✅ |
| 状态从创建到最终结果 E2E | 提交受理（AUTHORIZED + requestedBy 身份上下文展示）→ 详情 SUCCEEDED + attempts/acks；TIMED_OUT + 迟到 ACK 标注 | ✅ |
| Suspended/Retired/离线/无 Entitlement | 五组门控用例（禁用 + 原因展示）；Suspended 仍允许安全停止类（STOP/SHUTDOWN/REBOOT） | ✅ |
| requestedBy 不可编辑 | 表单无该字段；API 装配请求体断言无 requestedBy | ✅ |
| 媒体面板 DEC-009 | 无播放/停止按钮、无 video/audio/rtsp；手动刷新回调 | ✅ |
| CT-06 锚点 | device-operate 页 Adopt/Adapt 元素 ⇄ 锚点集合精确一致（Reject 不入表） | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。

## 4. 未决风险

- 命令列表/活动日志的 siteId/时间范围筛选契约支持但页面 V1 仅暴露 status/command/level/kind（设备上下文已隐含 deviceId）；如验收要求完整筛选维度可补充；
- 离线判定依赖 device.connectivity（lastHeartbeatAt ≤10 分钟派生，暂定值口径），与后端 DEVICE_STATE_NOT_ALLOWED 最终裁决一致；
- 加热/排气按钮映射为 ON/OFF 命令组（原型单按钮语义），操作者在表单内选定方向。
