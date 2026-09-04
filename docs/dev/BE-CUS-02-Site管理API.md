# BE-CUS-02 Site 管理 API

实现：[apps/cloud-api/src/admin/site](../apps/cloud-api/src/admin/site/index.ts)；OpenAPI：[contracts/rest/admin-site-api.json](../contracts/rest/admin-site-api.json)；验收测试：[admin-site.test.ts](../apps/cloud-api/test/admin-site.test.ts)（13 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CUS-02（P1 / 管理后台后端），依赖 BE-CUS-01（已交付）；复用 AUTH-01（RBAC/Guard）、DB-02（分页/乐观锁基础）、DOM-03（审计） |
| 地域模型 | DEC-011：Region/Subregion 为 Site 可筛选属性；设备仅经 siteId 关联 Site，不维护地域真值（本任务未触碰 Device 地域字段） |
| 功能边界 | 不处理地图和地理编码；不实现 Site 跨 Customer 迁移（customerId 创建后不可变） |

## 2. 端点与授权

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/admin/sites` | `site:read`（全部五角色） | `customerId`/`region`/`subregion`/`status` 筛选 + 键集游标分页（id ASC，limit 默认 50/上限 100）；Customer 角色的 customerId 由服务端身份上下文强制注入（query 指定他人 customerId → 403）；默认排除软删除 |
| `POST /api/v1/admin/sites` | `site:write`（SuperAdmin/Operator） | Customer 不存在/已删除 → 404；同 Customer 名称唯一（重复 → 409 CONFLICT）；初始 ACTIVE/version=1；创建与审计同事务 |
| `GET /api/v1/admin/sites/{siteId}` | `site:read` | 含设备数量（`_count` 单查询聚合，无 N+1）；Customer 角色跨 Customer → 403 |
| `PATCH /api/v1/admin/sites/{siteId}` | `site:write` + If-Match | 可更新 name/region/subregion/address/timezone/contactName/contactPhone/contactEmail；customerId 不可变（400）；至少一个字段 |
| `POST /api/v1/admin/sites/{siteId}/deactivate` | `site:write` + If-Match | ACTIVE→SUSPENDED；reason 必填入审计；重复停用 409 |
| `DELETE /api/v1/admin/sites/{siteId}` | `site:write` + If-Match | 软删除；有关联设备（任意生命周期）→ 409 CONFLICT 明确错误 |

字段校验：name 去空白 1~200；timezone 为 IANA 标识（Intl 内建校验，非法 → 400，缺省 UTC）；contactEmail 形态校验；其余可空字段限长（region/subregion/contact 200，address 500），空白归一为 null。审计动作：`site.create/update/deactivate/delete`（DOM-03，actorId/actorRole/customerId 注入，更新/停用/删除经 `audited` 失败记 FAILURE）。

## 3. 数据库变更

- `sites` 新增 `status TEXT NOT NULL DEFAULT 'ACTIVE'` 与 `version INTEGER NOT NULL DEFAULT 1`；
- Migration：[20260828130000_site_status_version](../packages/database/prisma/migrations/20260828130000_site_status_version/migration.sql)；
- 兼容/回滚：存量站点默认 ACTIVE/version=1，读取无影响；回滚为 `ALTER TABLE "sites" DROP COLUMN "status", DROP COLUMN "version"`（无数据迁移）。

## 4. 验收基准与证据（vitest + PGlite，13 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 错误 Customer 失败 | Customer 不存在/已软删除创建 Site → 404 NOT_FOUND | ✅ |
| 非法时区失败 | `Mars/Olympus`、`UTC+8`、`GMT+08:00`、`北京` → 400；`Asia/Shanghai`/`America/New_York` 通过；缺省 UTC | ✅ |
| 有关联设备删除失败 | 挂设备 Site 删除 → 409 CONFLICT（message 指明设备约束）且记录未删；无设备可删 | ✅ |
| 统计数量正确 | 详情/列表 deviceCount=实际设备数（2 台设备 → 2） | ✅ |
| CRUD/停用 | 创建默认值+审计；更新 version 自增+审计+null 清除；停用强制原因+重复 409；软删除行保留、后续 404/列表不可见 | ✅ |
| Customer 隔离 | Customer 角色列表强制本 Customer（指定他人 customerId 403）、详情跨 Customer 403；Auditor 平台只读；写操作 403/未认证 401 | ✅ |
| 附加 | 同 Customer 重名 409/跨 Customer 可重名；分页不重不漏；region/subregion/status 组合筛选；DTO 与 OpenAPI 封闭一致且不含 deletedAt；错误码对齐 CT-05；无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-site-api.test.ts`（3 项：六端点/If-Match/响应码齐备、Schema 封闭且更新体不含 customerId、$ref 可解析）。

## 5. 未决风险

- IANA 校验依赖 Node 运行时 ICU 数据库（Node ≥20 全量 ICU）；极端新时区命名以运行时为准，不构成安全边界；
- deviceCount 统计不分生命周期（含 Retired）；若前端需要"在线设备数"口径，由 BE-DEV-01 查询接口按四轴状态派生，不在本任务扩展；
- Region/Subregion 为自由文本可筛选属性（DEC-011@1.0.0 冻结值，非实体化字典）；若未来改为实体，需通过新决策版本迁移 Schema 与筛选契约。
