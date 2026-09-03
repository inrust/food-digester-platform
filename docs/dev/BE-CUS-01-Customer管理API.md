# BE-CUS-01 Customer 管理 API

实现：[apps/cloud-api/src/admin/customer](../apps/cloud-api/src/admin/customer/index.ts)；OpenAPI：[contracts/rest/admin-customer-api.json](../contracts/rest/admin-customer-api.json)；验收测试：[admin-customer.test.ts](../apps/cloud-api/test/admin-customer.test.ts)（14 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CUS-01（P1 / 管理后台后端），依赖 AUTH-01（RBAC/Guard）、DB-02（事务/分页/乐观锁基础）、DOM-03（审计写入），均已交付 |
| 形态 | 框架无关 Handler/Service/Repository，路由接线沿用 BE-ONB-02/BE-RPL-01 模式；Cognito actor 由适配层注入 |
| 错误码 | 对齐 CT-05 `contracts/rest/error-codes.json`（一致性由测试锁定） |
| 功能边界 | V1 仅软删除，不做物理删除；不实现 Customer 角色的数据读写扩展（矩阵固定，DEC-012） |

## 2. 端点与授权

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/admin/customers` | `customer:read`（平台三角色） | 键集游标分页（id ASC，DB-02 游标语义，limit 默认 50/上限 100）+ `status=ACTIVE\|SUSPENDED` 筛选；默认排除软删除 |
| `POST /api/v1/admin/customers` | `customer:write`（SuperAdmin/Operator） | 名称去空白，1~200 字符；初始 ACTIVE/version=1；创建与审计同事务 |
| `GET /api/v1/admin/customers/{customerId}` | `customer:read` 任意；Customer 角色仅自身 | Customer 角色无 `customer:read`（DEC-012 矩阵固定），经 `assertCustomerScope` 放行自身、跨 Customer 403 |
| `PATCH /api/v1/admin/customers/{customerId}` | `customer:write` + If-Match | 更新名称；版本不符 409 VERSION_CONFLICT |
| `POST /api/v1/admin/customers/{customerId}/deactivate` | `customer:write` + If-Match | ACTIVE→SUSPENDED；reason 必填入审计；重复停用 409 CONFLICT |
| `DELETE /api/v1/admin/customers/{customerId}` | `customer:write` + If-Match | 软删除；受约束（见 §3）时 409 CONFLICT 明确错误 |

写操作审计（DOM-03）：`customer.create/update/deactivate/delete`，actorId/actorRole/customerId 显式注入，前后值经脱敏器；更新/停用/删除经 `audited`（SUCCESS 与业务同事务，失败回滚后独立记 FAILURE）。

## 3. 删除约束（受约束删除的判定口径）

- **有效设备**：`devices.customerId = 该 Customer` 且生命周期非 `Rejected`/`Retired`（终态不阻塞）；
- **有效 License**：`licenses.customerId = 该 Customer` 且状态 ∈ `Issued/Active/ExpiringSoon/Renewed`（DOM-02 `isLicenseEffective` 的状态集合；删除约束按状态判定，不做时间派生，Expired/Revoked/Draft 不阻塞）；
- 命中任一约束 → 409 CONFLICT，message 指明约束类型与数量；删除为 `deletedAt` 标记 + version 自增，行保留（V1 无物理删除）。

## 4. 数据库变更

- `customers` 新增 `version INTEGER NOT NULL DEFAULT 1`（乐观锁，If-Match）；
- Migration：[20260828120000_customer_version](../packages/database/prisma/migrations/20260828120000_customer_version/migration.sql)；
- 兼容/回滚：存量行默认 version=1，对既有读取无影响；回滚为 `ALTER TABLE "customers" DROP COLUMN "version"`（无数据迁移，无依赖方）。

## 5. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| CRUD 通过 | 创建（201/ACTIVE/version=1/审计）、详情、更新（version 自增 + 审计）、停用（原因入审计）、软删除（行保留 + deletedAt 标记 + 审计） | ✅ |
| 游标分页/状态筛选通过 | limit=2 翻页覆盖全部记录不重不漏；SUSPENDED 筛选精确 | ✅ |
| 并发冲突通过 | If-Match 缺失 400；旧版本更新/删除 409 VERSION_CONFLICT | ✅ |
| 跨 Customer 隔离通过 | Customer 角色读自身 200、读他人 403、写操作（含自身）403；Auditor 写 403；未认证 401 | ✅ |
| 受约束删除返回明确错误 | 有效设备/有效 License → 409 CONFLICT（message 指明约束）；Retired 设备 + Expired/Revoked License 放行；重复删除 404 | ✅ |
| 附加 | 非法 limit/status/游标 400；DTO 字段与 OpenAPI 封闭一致且不含 deletedAt；错误码与 CT-05 目录一致；模块无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-customer-api.test.ts`（3 项：六端点/If-Match/响应码齐备、Schema 封闭、$ref 可解析）。

## 6. 未决风险

- Customer 实体当前仅 name/status 可写字段；联系信息等原型字段未定义于 DB-01，新增需先扩 Schema（BE-CUS 后续任务或 DB 变更任务）；
- 停用后无恢复（reactivate）端点：任务清单未要求，若业务需要挂起恢复，先更新任务清单再实现；
- 删除约束中“有效 License”按状态集合判定（不含时间窗口派生），与 DOM-02 `isLicenseEffective` 的完整判定存在窗口差异（无定时派生器时 Issued 过期未迁移仍视为有效，偏向保守拒绝，方向安全）。
