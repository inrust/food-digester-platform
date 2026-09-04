# BE-SYNC-01 Unified Device Sync API

实现：[apps/cloud-api/src/device/sync.ts](../../apps/cloud-api/src/device/sync.ts) + [sync-handler.ts](../../apps/cloud-api/src/device/sync-handler.ts)；OpenAPI：[contracts/rest/device-sync-api.json](../../contracts/rest/device-sync-api.json)；验收测试：[device-sync.test.ts](../../apps/cloud-api/test/device-sync.test.ts)（12 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-SYNC-01（P1 / 设备接口），依赖 AUTH-03、BE-CUS-01、BE-DEV-01、BE-LIC-01、BE-CFG-01、BE-DUSR-01（均已交付） |
| 定位 | 实施方案 8.5 强制接口：设备从 CMP 获取完整单一事实源快照；13 个 Notification 中 6 个（SYNC_REQUIRED/LICENSE_CHANGED/CONFIG_CHANGED/USERS_CHANGED/STATUS_CHANGED/ASSIGNMENT_CHANGED）的 deviceAction 均为 SYNC，指引设备调用本端点 |
| 聚合读取路径 | BE-CFG-01 `resolveEffectiveConfiguration`、BE-DUSR-01 `listDeviceUsersForSync`（本任务扩展验证材料下发）、BE-LIC-01 签名字段、BE-DEV-01 连接状态派生 |
| 功能边界 | 不实现设备端定时器与本地缓存（调用节奏是设备契约）；纯读取，无写入/通知/审计（高频接口，审计会淹没审计流） |

## 2. 端点与关键设计

`POST /api/v1/device/sync`（DeviceMtls，AUTH-03 `verifyDeviceCertificate` 白名单校验）。Retired 默认拒绝；DEC-014 仅允许存在 `PENDING_CONFIRMATION` 记录且尚未到 `initiatedAt+72h` 的 Retired 设备调用 Sync。到达精确边界即 fail closed，即使超时调度延迟也不扩大认证窗口。Suspended 放行。

**请求体封闭**：仅 `lastSyncTime`（UTC ISO 8601 或 null；首次同步可省略请求体）；未知字段/非法时间戳 → 400 VALIDATION_FAILED。

**响应为全量事实快照**（不做增量裁剪；`lastSyncTime` 仅接收并回显），六域：

| 域 | 内容 | 空态 |
|---|---|---|
| `assignment` | 当前 ACTIVE 分配：customerId/customerName、siteId/siteName、Region/Subregion、授权窗口 [assignedAt, endedAt) | 未分配 → null |
| `device` | 别名、序列号、型号、固件版本 | — |
| `license` | 有效优先（EFFECTIVE 状态且在有效期内），否则最新一条；状态/有效期/Entitlements（仅 enabled）/签名/version/effective | 未许可 → null |
| `deviceUsers` | 本 Customer ACTIVE 用户中 ACTIVE 分配到本设备者；含 DEC-004 验证材料四字段（version+kdf+salt+hash）——Sync 域是唯一授权下发通道，查询 API 永不返回；停用用户不下发 | 未分配 Customer 或无授权 → [] |
| `configuration` | 设备定向优先于型号定向；已发布且已到 effectiveAt 的最高版本（未来生效不下发） | 无有效配置 → null |
| `operationalStatus` | lifecycleStatus + operationalStatus（设备上报值，未上报按生命周期兜底）+ connectivity（心跳阈值派生，不写回）+ syncIntervalSeconds | — |

**版本/ETag**：`etag` = 稳定域（assignment/device/license/deviceUsers/configuration/生命周期与同步节奏）规范 JSON 的 SHA-256；volatile 域（snapshotAt/connectivity/lastHeartbeatAt）不参与，避免心跳噪声导致 etag 漂移。即使 etag 未变化也返回完整快照（不得省略设备无法安全缓存的必要域）。

**同步节奏**（设备契约，云端以下发值指引）：Active=300s、Suspended=900s；Maintenance 经 DEC-001 行为矩阵注入（`maintenanceSyncIntervalSeconds`，消费方禁止直接读矩阵 JSON 或复制冻结值——组合根必须经 `contracts/lifecycle/maintenance-behavior.ts` 的 `getMaintenanceSyncIntervalSeconds()` 接线，冻结值为 900）；其余生命周期沿用 Active 节奏（暂定）。

**租户隔离**：Assignment/Device Users 以证书绑定设备的 customerId 严格限定（Customer 数据不串线）；License/Configuration 按 deviceId 限定。

## 3. 验收基准与证据（vitest + PGlite，9 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 六域齐备的完整快照 | Active 设备：Assignment（名称/Region/授权窗口）+ Alias + License（Active+签名+enabled Entitlements）+ Device Users（verifier 四字段）+ 设备定向 Configuration + Operational Status（ONLINE/300s） | ✅ |
| 不同生命周期快照正确 | Suspended 可同步（900s）；Maintenance operationalStatus 节奏经 DEC-001 注入（900s）；Onboarded 未分配可同步 | ✅ |
| 未分配/未许可状态 | assignment/license/configuration=null、deviceUsers=[]；型号定向配置对未分配设备仍下发 | ✅ |
| Customer 数据不串线 | 跨 Customer 用户/未分配本设备/停用用户均不下发；两 Customer 各自快照隔离 | ✅ |
| 未来生效配置不下发；未许可语义 | effectiveAt 未来 → configuration=null；Expired License effective=false 仍可见最新状态 | ✅ |
| 版本/ETag | 重复同步 etag 一致；心跳（volatile）变化不影响 etag；alias（稳定域）变更后 etag 变化 | ✅ |
| 认证与请求校验 | Retired 默认 403；待确认且窗口内 Sync 200；精确 72h 边界 403；未登记/缺身份 → 401；非法请求 → 400 | ✅ |
| 敏感材料不泄露 | 响应序列化不含证书包/PEM/私钥/明文密码字段 | ✅ |
| 契约一致性 | 响应字段与 OpenAPI 封闭一致（含全部嵌套域）；错误码对齐 CT-05；sync 模块无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/device-sync-api.test.ts`（4 项：端点/认证/响应码、请求体封闭、六域与敏感字段、$ref 可解析）。

## 4. 未决风险

- `maintenanceSyncIntervalSeconds` 为依赖注入：cloud-api 不经 tsc 构建引用 contracts 源码包，组合根（Lambda 入口接线任务）必须经 `getMaintenanceSyncIntervalSeconds()` 注入；当前仅测试注入 900 验证接线语义；
- etag 为响应体字段而非 HTTP ETag 头：框架无关 Handler 不产出传输层头，Lambda 适配层如需 `ETag`/`If-None-Match` 头可直接映射 data.etag（语义等价）；
- `lastSyncTime` 当前仅回显：增量裁剪被任务边界明确排除（不得省略必要域）；未来若引入增量，需以 lastSyncTime 与各域版本（license.version、deviceUsers[].version、configuration.version）联合判定，快照字段均已就位；
- DEC-004 冻结前 `verifier.kdf/version` 可为 null（数据库按"字符串验证值 + 版本"设计，未固化算法列）；冻结后 BE-DUSR-02 补测试向量并收敛必填约束。
