# BE-OTA-02 OTA Campaign API 与状态机

实现：[apps/cloud-api/src/admin/ota-campaign](../apps/cloud-api/src/admin/ota-campaign)（errors/service/handler）；REST 契约 [contracts/rest/admin-ota-campaign-api.json](../contracts/rest/admin-ota-campaign-api.json)；验收测试 [admin-ota-campaign.test.ts](../apps/cloud-api/test/admin-ota-campaign.test.ts)（14 项）+ 契约测试（4 项）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-OTA-02（P2 / 管理后台后端），依赖 BE-OTA-01（VERIFIED 包）、BE-DEV-01（设备台账/生命周期）、BE-LIC-01（OTA_UPDATE Entitlement）、DOM-03（audited） |
| 事实源 | 实施方案 §11.8（OTA 流程：首批 1 台灰度 → 确认后扩大/暂停；试运营禁止默认全量强制升级）；关键问题 §4.10（灰度/暂停/取消/失败重试）；DEC-001（Maintenance 允许 OTA）；DEC-015（ACK 为 OTA 状态唯一上行通道） |
| 存储 | 复用既有 `ota_campaigns`/`ota_targets`/`ota_status_history` 表（DB-01/DB-02 已建），**无新增 Migration** |
| 功能边界 | 不执行固件安装；MQTT 下发与 ACK 消费属 BE-OTA-03（本任务提供 `recordTargetStatus` 供其复用） |

## 2. 关键设计

**API**（Cognito 认证；写 `ota:write`，读 `ota:read`；Customer 角色无 OTA 权限 → 403）：

| 端点 | 语义 |
|---|---|
| `POST /api/v1/admin/ota/campaigns` | 创建：VERIFIED 包 + 强制首批恰好 1 台 → RUNNING（201） |
| `POST /{campaignId}/batches` | 扩大批次（仅 RUNNING；禁止全量；已有设备幂等跳过）→ 201 |
| `POST /{campaignId}/pause` / `resume` | RUNNING⇄PAUSED（幂等回放；非法态 409） |
| `POST /{campaignId}/cancel` | RUNNING/PAUSED/DRAFT→CANCELLED，级联未完成 target → CANCELLED（幂等回放；COMPLETED → 409） |
| `POST /{campaignId}/retry` | FAILED target → PENDING（仅 RUNNING；可选 targetIds 子集） |
| `GET /campaigns` / `/{id}` / `/{id}/targets` | 列表（筛选+键集游标）/ 详情（含 9 态 target 计数看板）/ 目标列表 |

**状态机**：Campaign `RUNNING⇄PAUSED→CANCELLED`，全部 target SUCCEEDED 时 `recordTargetStatus` 同事务自动 → COMPLETED（含审计）。Target 封闭集合 `PENDING→NOTIFIED→DOWNLOADING→INSTALLING→SUCCEEDED/FAILED/ROLLED_BACK`，FAILED 仅经 retry → PENDING，CANCELLED 终态；所有写均为条件更新（并发兜底 → 409）。

**资格门**（创建/扩大共用）：设备存在 + 型号匹配包的 targetModel + 生命周期 Active/Maintenance + 有效 License 且 `OTA_UPDATE` Entitlement enabled（沿用 BE-CMD-01 门模式）。

**禁止全量强制升级**：单次选择与"合并已有 target 后"覆盖该型号全部合格设备（型号+生命周期+Entitlement 三重过滤）均 → 400。

**暂停/取消后不得产生新下发**：PAUSED/CANCELLED 拒绝扩大批次与重试（409）；取消级联未完成 target（PENDING/NOTIFIED/DOWNLOADING/INSTALLING）→ CANCELLED；下发语义 = 仅 RUNNING Campaign 的 PENDING target（BE-OTA-03 消费）。

**审计**：Campaign 每次状态变化经 `audited` 写 `audit_logs`（create/expand/pause/resume/cancel/retry/complete）；Target 每次状态变化写 `ota_status_history`（同事务，from→to+detail）。幂等回放不重复写审计/历史。

## 3. 验收基准与证据（vitest + PGlite，14 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 首批超过 1 台被拒绝 | 0/2/去重后 2 台 → 400；去重后恰好 1 台放行 | ✅ |
| 暂停/取消后不得产生新下发 | PAUSED/CANCELLED 扩大批次与重试 → 409；取消级联未完成 target → CANCELLED，SUCCEEDED 保留 | ✅ |
| 每次状态变化有审计 | Campaign 操作各 1 条 audit_logs；Target 创建/推进/取消/重试每步 1 条 ota_status_history；幂等回放不重复 | ✅ |
| 设备需 OTA Entitlement | 无 License/Entitlement 停用/仅 REMOTE_CONTROL/License 过期 → 400；Suspended/Retired/型号不匹配/不存在 → 400；Maintenance 放行（DEC-001） | ✅ |
| 禁止默认全量强制升级 | 单次全量 → 400；分批合并覆盖全量 → 400 且不新增 target | ✅ |
| 坏包不可建 Campaign | 非 VERIFIED → 400；不存在 → 404 | ✅ |
| 状态机与幂等 | pause/resume/cancel 幂等回放 200；非法迁移 409；recordTargetStatus 合法链/非法迁移/未知状态/幂等回放；全部 SUCCEEDED 自动 COMPLETED + 审计 | ✅ |
| 鉴权 | 无 actor → 401；CustomerAdmin/Auditor 写 → 403；Customer 读 → 403 | ✅ |

## 4. 未决风险

- **MQTT 下发与 ACK 消费未实现**（BE-OTA-03）：本任务仅维护状态机；Campaign RUNNING + target PENDING 即"待下发"，下发器消费语义已在契约与代码注释固定。
- **单设备型号的首批即全量**：型号仅 1 台合格设备时首批 1 台等于全量，属合理灰度（无更大样本），如需拦截另行决策。
- **暂停中的在途 target**（NOTIFIED/DOWNLOADING/INSTALLING）暂停时保持原态，由设备侧/ACK 继续推进或经取消级联；如需"暂停即冻结在途"语义，属新决策。
- **OTA Entitlement 编码**：DB/领域层为 `OTA_UPDATE`，设备线 REST 投影为 `OTA`（既有 CT 对齐测试锁定不改名）；本任务资格判定使用 DB 编码 `OTA_UPDATE`。
