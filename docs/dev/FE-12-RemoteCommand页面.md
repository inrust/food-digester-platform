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
- **M/N（搅拌间隔/时长）不进入 V1**：按 DEC-018 拒绝原型入口；温度阈值跳转 `/configurations` 版本发布（FE-09），两者均不产生设备命令；
- 未知命令 code 在类型层与运行时（commandSpecOf 抛错）双重禁止。

## 当前分层状态

| 层级 | 当前结论 | 证据边界 |
|---|---|---|
| module present | PASS | 页面、命令目录镜像、API adapter 与定向测试存在。 |
| app integrated | PASS | `/devices/operate` 由正式 controller 接入组合根；温度命令在 adapter 层失败关闭。 |
| browser verified | PASS | 本地 Chromium mock E2E 覆盖正式路由和命令交互；不等同真实 IoT 下发。 |
| target integrated | NOT RUN / NO RECEIPT | 尚无真实 Cognito、已部署 API/IoT 与精确提交回执。 |

当前整改依据：[FE-11 至 FE-15 全面复盘检查报告](../audit/FE-11至FE-15全面复盘检查报告-2026-09-12.md)。目标环境采集依据：[FE-11 至 FE-15 目标环境验收证据采集说明](../audit/evidence/FE-11至FE-15-目标环境验收证据采集说明.md)，发布时显式执行 `pnpm check:admin-web-fe11-15-target-evidence`。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `DeviceOperatePage`（/devices/operate） | ScopeFilter 联动选设备；当前运行状态（四轴徽标）；快捷操作 + 配置跳转；命令表单（命令白名单下拉、timeoutSec 1~3600、remarks ≤500、高风险确认凭证输入）；命令状态列表（状态/命令筛选 + 游标分页）；命令详情（attempts/acks 时间线、**迟到 ACK** 标注）；操作日志（级别/类型筛选 + 异步 CSV 导出）；最新媒体面板 |
| `command-state.ts` | COMMAND_CATALOG（CT-04 镜像）、COMMAND_LABELS、QUICK_ACTIONS 映射、gateCommand（command:send ∩ 运行状态轴 ∩ 在线 ∩ REMOTE_CONTROL）、状态/ACK/日志文案、isLateAck、CT-06 锚点表 |
| `commands-api.ts` | createDeviceCommand（不含 requestedBy）/fetchCommands/fetchCommand/fetchDeviceActivities/createActivityExport/fetchActivityExport |

### 顺带修复（组件缺陷）

`Modal` 的 focus effect 依赖内联 `onClose` 导致每次父级渲染重新聚焦对话框、吞掉后续键盘输入（页面级表单状态时必现）。修复为 `onCloseRef` 持有 + effect 仅依赖 `open`（Esc 与焦点回收语义不变，既有测试全绿）。

## 3. 验收基准与仓库内证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 命令与快捷动作映射 | CT-04 目录逐条 parity；快捷动作只映射正式 code | 仓库内 PASS |
| 无协议 code 与温度命令失败关闭 | 未知 code 抛错；`SET_TARGET_TEMPERATURE` 不进入可提交集合且 adapter 不发请求 | 仓库内 PASS |
| 高风险确认 | confirmText 不匹配时禁用；请求不接受客户端认证时间 | 仓库内 PASS |
| 状态可见性 | 包含 `PUBLISH_FAILED`、终态、attempts/acks 与迟到 ACK | 仓库内 PASS |
| 设备与授权门控 | Suspended/Retired/离线/无 Entitlement 均有明确裁决 | 仓库内 PASS |
| requestedBy 与媒体边界 | requestedBy 不可编辑；媒体区无实时流语义 | 仓库内 PASS |
| CT-06 锚点 | 页面元素与覆盖矩阵 parity | 仓库内 PASS |

验证命令：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm check:admin-web-delivery`、`pnpm check:admin-web-e2e`。结果只支持前三层；真实下发与 Cognito 权限必须由目标回执证明。

## 4. 未决风险

- 命令列表/活动日志的 siteId/时间范围筛选契约支持但页面 V1 仅暴露 status/command/level/kind（设备上下文已隐含 deviceId）；如验收要求完整筛选维度可补充；
- 离线判定依赖 device.connectivity（DEC-024@1.0.0：lastHeartbeatAt 距 now ≤600 秒，包含边界），与后端 DEVICE_STATE_NOT_ALLOWED 最终裁决一致；
- 加热/排气按钮映射为 ON/OFF 命令组（原型单按钮语义），操作者在表单内选定方向。
- Owner：Release Engineering；关闭条件：真实危险命令、越权拒绝、重复提交和发布失败回执通过独立 Gate；当前保持 NOT RUN / NO RECEIPT。
