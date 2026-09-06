# BE-DEV-06 设备可编辑元数据 API

实现：扩展既有设备模块 [apps/cloud-api/src/admin/device](../apps/cloud-api/src/admin/device)（新增 [metadata-service.ts](../apps/cloud-api/src/admin/device/metadata-service.ts)；handler 增加 PATCH 路由；errors 增加 CONFLICT/VERSION_CONFLICT）；契约扩展 [admin-device-api.json](../contracts/rest/admin-device-api.json)；验收测试 [admin-device-metadata.test.ts](../apps/cloud-api/test/admin-device-metadata.test.ts)（7 项，PGlite）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DEV-06（P1 / 管理后台后端），依赖 BE-DEV-01（设备台账与详情 DTO）、AUTH-01（device:write）、DOM-03（审计） |
| 事实源 | If-Match 基准 = `devices.updatedAt`（BE-DEV-01 详情 DTO 已暴露）；权限矩阵 DEC-012（device:write 仅 PlatformSuperAdmin/PlatformOperator——Customer 角色经矩阵 403） |
| Schema 变更 | 无（复用 devices.updatedAt 作乐观锁基准，无需新增 version 列） |
| 功能边界 | 不修改 Assignment/Configuration 或设备端本地名称（alias 变更经 BE-SYNC 稳定域 etag 感知下发，非本接口直推）；不接受任意 JSON merge patch |

## 2. 关键设计

**路由**：`PATCH /api/v1/admin/devices/{deviceId}/metadata`（device:write）。If-Match 头必填（值 = 设备当前 updatedAt ISO8601，来自 GET 详情）。

**字段白名单（受保护字段修改失败）**：请求体仅允许 `alias`；携带任何其他字段（deviceId/serialNumber/Customer/Site/Contract/License/生命周期/连接状态/固件/证书/merge-patch 操作符）→ 400，且不产生任何更新（校验先于写库）。

**alias 规则（暂定值，见未决风险）**：去除首尾空格；`null` = 清除别名；非空 1..64 字符；同一 Customer 内唯一（trim 后精确匹配、大小写敏感；未分配设备在 customerId=null 域内判重）→ 冲突 409 CONFLICT。

**乐观锁（并发冲突）**：If-Match 缺失/非法 → 400；与台账 updatedAt 不一致 → 409 VERSION_CONFLICT；条件更新 `where {id, updatedAt}` 兜底并发漂移（count≠1 → 409）。单条条件更新 + 同事务审计 → 失败请求不产生部分更新。

**审计**：`device.metadata.update`（actor/角色/Customer/before/after alias），DOM-03 同事务。

## 3. 验收基准与证据（vitest + PGlite，7 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 合法 alias 修改成功并留审计 | trim 生效；返回新 updatedAt（可作下次 If-Match 基准继续改/清除）；审计 before/after/actor 齐备 | ✅ |
| 越权失败 | CustomerViewer/CustomerAdmin（本+跨 Customer）→ 403（DEC-012 矩阵）；无 actor → 401；不存在 → 404 | ✅ |
| 并发冲突失败 | If-Match 缺失/非法 → 400；陈旧基准 → 409；他方先行修改后提交 → 409 且值保持 | ✅ |
| 空 alias/超长/类型/缺字段 | 均 400 VALIDATION_FAILED 且库不变 | ✅ |
| alias 唯一性 | 同 Customer trim 后冲突 → 409 CONFLICT 且不落库；跨 Customer 同名放行；自身同值放行；大小写敏感（暂定规则） | ✅ |
| 受保护字段修改失败 | 11 类字段（含 `$set` merge-patch 操作符）→ 400，设备行深比较无任何变化 | ✅ |
| 失败不产生部分更新 | 全部失败用例校验库中记录不变 | ✅ |

## 4. 未决风险

- **alias 唯一性/长度无已冻结规则**：任务要求「按已冻结规则校验唯一性」，但决策登记（contracts/decisions）与契约中不存在 alias 唯一性/长度的冻结值。本实现按暂定规则执行（trim 精确匹配、大小写敏感、1..64、同 Customer 域）并在契约描述中声明「暂定」；冻结需登记新决策，届时规则变化须同步契约与测试。
- **If-Match 基准为 updatedAt 而非独立 version 列**：devices 表无 version；其他写路径（如生命周期服务）更新 updatedAt 后旧 If-Match 自然失效（语义更安全）。若未来需要区分元数据版本与任意台账变更，可另立 version 列迁移。
- **Customer 角色不可编辑别名**：DEC-012 冻结矩阵未授予 Customer 角色 device:write；若业务需要客户自助改名，须另立版本化决策修订矩阵。
