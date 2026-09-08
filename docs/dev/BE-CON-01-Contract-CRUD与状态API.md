# BE-CON-01 Contract CRUD 与状态 API

实现：[apps/cloud-api/src/admin/contract](../../apps/cloud-api/src/admin/contract/index.ts)；领域规则：[packages/domain/src/contract.ts](../../packages/domain/src/contract.ts)；OpenAPI：[contracts/rest/admin-contract-api.json](../../contracts/rest/admin-contract-api.json)；验收测试：[admin-contract.test.ts](../../apps/cloud-api/test/admin-contract.test.ts)+ 领域单测 [contract.test.ts](../../packages/domain/test/contract.test.ts)。

> 证据治理：当前本地全仓证据命令为 `pnpm verify`；精确快照与整改闭环见 [全面复盘检查报告](../audit/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md)。目标 AWS 验收必须按 [证据采集说明](../audit/evidence/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md) 生成与待发布提交绑定的回执，并通过 `pnpm check:aws-admin-business-evidence`；缺失回执不得以本地测试替代。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CON-01（P1 / 管理后台后端），依赖 AUTH-01、DB-02、BE-CUS-01、DOM-03、DEC-007（均已交付） |
| 状态机 | 领域层为唯一事实源：DRAFT →activate（显式）→ EFFECTIVE →时间派生→ EXPIRING_SOON（DEC-021@1.0.0 冻结 30 天窗口）→ EXPIRED；任意非终态 →terminate（强制原因）→ TERMINATED（终态）；EXPIRED 粘性，仅经 renew 离开 |
| 写操作约束 | 所有写操作：If-Match 乐观锁（`contracts.version` 条件更新，漂移 → 409 VERSION_CONFLICT）+ 强制原因 + DOM-03 audited 审计（`contract.create/update/activate/renew/terminate/evaluate`） |
| 唯一性 | contractNumber 全局唯一（DB 唯一约束 P2002 → 409 CONFLICT）；startAt < endAt（领域校验 + DB CHECK 兜底） |
| 最小权限 | contact 仅 PlatformSuperAdmin/PlatformOperator 可见，Auditor 视图遮蔽为 null；Customer 角色无 contract:read，整接口 403 |
| 功能边界（DEC-007） | 不管理价格/开票/收付款/电子签署；不自动创建、激活或续期 License |

## 2. 端点

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/contracts` | `contract:write`（仅 SuperAdmin，DEC-012） | 创建 DRAFT；201 |
| `GET /api/v1/admin/contracts` | `contract:read` | 列表；`status` 作用于查询时点派生状态（derivedStatus，不写回），支持 customerId |
| `GET /api/v1/admin/contracts/{id}` | `contract:read` | 详情（status 落库值 + derivedStatus 派生值） |
| `PATCH /api/v1/admin/contracts/{id}` | `contract:write` | 编辑 name/contact；startAt/endAt 仅 DRAFT 可改（生效后延长走 renew） |
| `POST .../activate` | `contract:write` | DRAFT→EFFECTIVE；非 DRAFT → 409 |
| `POST .../renew` | `contract:write` | EFFECTIVE/EXPIRING_SOON/EXPIRED 延长 endAt（必须更晚 → 否则 400），状态按新窗口重推导；DRAFT/TERMINATED → 409 |
| `POST .../terminate` | `contract:write` | 任意非终态→TERMINATED；重复终止 409 |
| `POST .../evaluate` | `contract:write` | 可测试时间派生（`at` 可注入）：到期边界复验并落库；无变化 changed=false 且无写入/审计 |

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 列表、详情、新建、编辑、续约和终止路径均有接口 | 全路径链路：创建 DRAFT→编辑→激活→续约→终止，每步状态/version 断言 | ✅ |
| 重复编号、非法日期、越权和并发修改被拒绝 | 重复 contractNumber 409；startAt≥endAt/非法时间 400；Customer 不存在 404；非 DRAFT 激活 409、DRAFT 续约 409、TERMINATED 后写 409；Operator 写 403、Customer 403、未认证 401；If-Match 缺失 400、漂移 409 VERSION_CONFLICT；缺原因 400（写被拒后版本不变） | ✅ |
| 到期边界可注入时间复验 | evaluate 注入 at：无变化无写入/审计 → EXPIRING_SOON → EXPIRED 各落库一次；EXPIRED 粘性（读取不回退）；过期后可续约回 EFFECTIVE | ✅ |
| 所有写操作 If-Match、原因和审计 | 每步审计恰好一次（create/update/activate/renew/terminate/evaluate 计数） | ✅ |
| Customer 联系方式按最小权限返回 | SuperAdmin/Operator 见 contact；Auditor 视图 null；Customer 角色 403 | ✅ |
| 附加 | 派生状态筛选（EXPIRED/EFFECTIVE/非法 400）；错误码对齐 CT-05 目录；DTO 与契约封闭一致；无 AWS 依赖 | ✅ |

领域单测：`pnpm vitest run packages/domain/test/contract.test.ts`。契约测试：`node --import tsx --test contracts/rest/admin-contract-api.test.ts`（自动化契约回归）。

## 4. 未决风险

- EXPIRING_SOON 窗口已按 DEC-021@1.0.0 冻结为 30 个自然日（精确 30×86400 秒，UTC instant，窗口起点包含边界）；
- 无定时到期扫描：状态由显式动作与 evaluate/读取时点派生确定（与 License 一致；调度接入留给运维侧）；
- 续约/终止不联动 License（DEC-007：Contract 管商业租期，License 管能力授权；联动策略未定义）；
- contact 最小权限按角色遮蔽（Auditor 为 null）；如 Auditor 需查看需调整矩阵。
