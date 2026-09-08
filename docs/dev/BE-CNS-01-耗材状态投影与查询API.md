# BE-CNS-01 耗材状态投影与查询 API

实现：[apps/cloud-api/src/consumable](../../apps/cloud-api/src/consumable/index.ts)；领域规则：[packages/domain/src/consumable.ts](../../packages/domain/src/consumable.ts)；OpenAPI：[contracts/rest/admin-consumable-api.json](../../contracts/rest/admin-consumable-api.json)；验收测试：[admin-consumable.test.ts](../../apps/cloud-api/test/admin-consumable.test.ts)+ 领域单测 [consumable.test.ts](../../packages/domain/test/consumable.test.ts)。

> 证据治理：当前本地全仓证据命令为 `pnpm verify`；精确快照与整改闭环见 [全面复盘检查报告](../audit/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md)。目标 AWS 验收必须按 [证据采集说明](../audit/evidence/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md) 生成与待发布提交绑定的回执，并通过 `pnpm check:aws-admin-business-evidence`；缺失回执不得以本地测试替代。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CNS-01（P2 / 管理后台后端），依赖 DB-02、BE-IOT-05、BE-DEV-01、DEC-008（均已交付） |
| 类型封闭集合 | `CARBON_FILTER`/`BIO_ADDITIVE`（DEC-008；与 consumables-policy.json 一致性由单测强制；新增类型必须走决策冻结） |
| 数据来源 | device-reported-only：仅保存设备上报值（原始名经领域字典映射）；云端不推算百分比；未上报为 null，DTO `remainingDisplay='unknown'`（绝不默认 50%） |
| 字典映射 | 原型两列严格分离：`碳包/碳滤网/carbon*`→CARBON_FILTER，`活性菌/添加剂/bio*`→BIO_ADDITIVE（trim+小写归一）；未知名称失败关闭（`UNKNOWN_CONSUMABLE_TYPE`，不落库） |
| 乱序防护 | 每设备每耗材仅最新投影：领域 `decideProjectionUpdate`（更旧/同时刻异消息 → 拒绝；同消息同时间 → replay 幂等）+ `observedAt` 条件更新并发兜底 |
| stale | 读取时点派生（observedAt 超过 DEC-008@1.0.0 冻结阈值 24h，或未上报 → stale），不回写 |
| 联系人授权摘要 | Site 联系方式仅 PlatformSuperAdmin/PlatformOperator/CustomerAdmin 可见；Auditor/CustomerViewer → null；Customer 角色租户隔离（仅本 Customer） |
| 功能边界 | 不预测更换日期、不虚构未上报值、不自动联系客户或创建采购单（BE-CNS-02 才管理工单） |

## 2. 接口与写路径

- `GET /api/v1/admin/consumables`（device:read）：耗材状态列表。筛选（AND 组合）：`region`/`subregion`/`siteId`/`connectivity`(ONLINE|OFFLINE)/`keyword`（设备 ID/序列号/别名）/`maxRemainingPercent`+`consumableType`（阈值；unknown 不参与）/`customerId`（平台角色）。
- 投影写路径 `recordConsumableReport`（service 导出，供采集链路调用；BE-IOT-05 的冻结 telemetry 契约无耗材字段，故投影接入点在本任务落地）：字典映射 → 百分比校验 → 乱序防护 → 落库（含来源消息 sourceMessageId 与 observedAt）。
- DB：`consumable_projections.customer_id` 改为可空（migration `20260829100000`；设备未分配 Customer 时投影仍可保存，customerId 为冗余查询列镜像 devices 可空性）。

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 原型两种耗材列均能稳定映射 | 碳包/碳滤网/Carbon Filter → CARBON_FILTER；活性菌/添加剂/Bio Additive → BIO_ADDITIVE；不混用 | ✅ |
| 旧消息不覆盖新值 | 更旧 observedAt 拒绝（remaining 保持新值、sourceMessageId 不变）；同消息同时间 replay 幂等无写入 | ✅ |
| 未知值显示 unknown 而非 50% | 未上报百分比 → `remainingPercent=null` + `remainingDisplay='unknown'`；未上报耗材列 → null | ✅ |
| 未知类型/越界拒绝 | 未知耗材名失败关闭零落库；百分比 -1/101/50.5 拒绝；设备不存在 404 | ✅ |
| 阈值和多条件筛选正确 | maxRemainingPercent+consumableType、Region/Subregion/Site、连接状态、关键字组合；unknown 不参与阈值筛选；非法筛选值 400 | ✅ |
| 联系人只向授权角色返回 | SuperAdmin/Operator/CustomerAdmin 见联系人；Auditor/CustomerViewer → null；Customer 租户隔离；未认证 401 | ✅ |
| 附加 | stale 派生（25h → stale=true）；DTO 与契约封闭一致；错误码对齐 CT-05；无 AWS 依赖 | ✅ |

领域单测 6/6；契约测试 3/3（`node --import tsx --test contracts/rest/admin-consumable-api.test.ts`）。

## 4. 未决风险

- stale 阈值已按 DEC-008@1.0.0 冻结为 24h，由 `CONSUMABLE_STALE_AFTER_MS` 统一承载；
- 投影写路径目前由本任务 service 提供；BE-IOT-05 冻结的 telemetry 契约不含耗材字段，设备耗材上报消息格式待协议定义后由采集链路调用 `recordConsumableReport`；
- 正式展示名称与低余量阈值已按 DEC-008@1.0.0 冻结：`CARBON_FILTER`/碳滤网为 20%，`BIO_ADDITIVE`/生物添加剂为 15%；查询 API 的 `maxRemainingPercent` 仍是显式覆盖入参；
- 联系人授权角色集合（SuperAdmin/Operator/CustomerAdmin）为暂定判定，冻结需业务方确认。
