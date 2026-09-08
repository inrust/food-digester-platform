# FE-10 Alarm/Event/Tamper 页面

实现：[apps/admin-web/src/pages/alarms](../../apps/admin-web/src/pages/alarms/AlarmsPage.tsx)；测试：[alarms.test.tsx](../../apps/admin-web/test/alarms.test.tsx)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | FE-10（P1），依赖 FE-02（已交付）、BE-ALM-01（admin-alarm-api.json，契约 + 后端已实现） |
| 路由 | `/alarms`（扩展路由，告警与事件；alarm:read = 全部五角色；Customer 角色租户隔离由服务端强制，跨 Customer 详情/处理 → 404） |
| 状态机 | ACTIVE→确认/清除、ACKNOWLEDGED→清除、CLEARED 终态（领域层封闭校验；矩阵与契约 parity 锁定） |
| 幂等 | 重复确认/清除 replayed=true（无写入/审计/领域事件），页面提示“重复操作已幂等忽略” |
| 功能边界 | 只呈现业务告警/事件/防拆；不展示 CloudWatch/SQS/RDS 等 AWS 运维告警（DOM 负向断言锁定） |

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `AlarmsPage`（/alarms） | 三 Tab（告警/事件/防拆）；告警列表（severity 徽标 + CRITICAL 行级显著样式）；详情面板（代码/类别/当前值/阈值/建议处置/确认与清除审计字段）；确认/清除（ConfirmDialog 强制原因）；Event/Tamper 只读列表（Tamper details 原样 JSON 透传）；键集游标分页 |
| `alarm-state.ts` | 状态机矩阵 + `gateAlarmAction`（矩阵 ∩ alarm:write）；severity/status 枚举与文案；**筛选 ⇄ URL 同步**（`urlStateToSearch`/`urlStateFromSearch`，非法枚举静默丢弃） |
| `alarms-api.ts` | fetchAlarms/fetchAlarm/acknowledgeAlarm/clearAlarm/fetchDeviceEvents/fetchTamperEvents（筛选 + cursor 查询串） |
| `CursorTable` 扩展 | 新增可选 `rowClassName`（CRITICAL 显著行；向后兼容） |

筛选：severity/status/device/site/customer（平台角色）/时间范围（from/to，detectedTime/occurredAt 含边界）；Event 无 severity/status，Tamper 无 status。

## 3. 验收基准与证据（vitest + jsdom，10 例 + parity 1 例）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 状态更新正确 | ACTIVE→确认（原因必填）→ACKNOWLEDGED→清除→CLEARED 无动作；每步成功后回源刷新 | ✅ |
| 重复操作正确 | replayed=true → “重复操作已幂等忽略（无重复写入/审计）”提示 | ✅ |
| 筛选参数与 URL 同步 | 应用筛选 → onApplyUrlState → `urlStateToSearch` 查询串 → `urlStateFromSearch` 回读一致；urlState prop 变化触发 replaceState 更新 location.search；非法参数回退默认 | ✅ |
| 跨 Customer 不可见 | 详情 404 NOT_FOUND 呈现；Customer 角色不渲染客户筛选；无 alarm:write 角色按钮禁用 + 403 呈现 | ✅ |
| 确认/清除原因必填 | 空原因确认按钮禁用；409 终态冲突错误可读 | ✅ |
| Critical 显著且不混 AWS 运维告警 | severity-critical 行样式 + “严重”徽标；页面文本无 CloudWatch/SQS/RDS | ✅ |
| 契约对齐 | severity/status 枚举与 Alarm schema 一致；矩阵 ⊆ 契约封闭状态机 | ✅ |

当前证据命令：`pnpm exec vitest run`、`pnpm --filter @fdp/admin-web exec tsc --noEmit`、`pnpm exec vitest run apps/admin-web/test/contract-parity.test.ts`。

## 4. 未决风险

- URL 仅携带当前 Tab 的筛选（设计决策：三 Tab 共享参数名避免冲突）；切 Tab 回读时其他 Tab 筛选重置为默认；
- siteId 筛选为自由文本输入（契约语义“经设备归属解析”）；如候选站点下拉需 sites 列表装配层注入，待应用壳层集成时接线；
- CRITICAL 显著目前为行级 className（`severity-critical`），视觉样式待 FE-02 样式表补充类规则（当前以 data 属性/类名锁定语义，测试已锚定）。
