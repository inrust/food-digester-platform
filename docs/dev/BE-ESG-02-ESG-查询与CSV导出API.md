# BE-ESG-02 ESG 查询与 CSV 导出 API

实现：[apps/cloud-api/src/admin/esg/](../../apps/cloud-api/src/admin/esg/index.ts)（errors/csv/service/export-service/handler）；OpenAPI：[contracts/rest/admin-esg-api.json](../../contracts/rest/admin-esg-api.json)；验收测试：[admin-esg.test.ts](../../apps/cloud-api/test/admin-esg.test.ts)。

> 证据治理：当前本地全仓证据命令为 `pnpm verify`；精确快照与整改闭环见 [全面复盘检查报告](../audit/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md)。目标 AWS 验收必须按 [证据采集说明](../audit/evidence/BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md) 生成与待发布提交绑定的回执，并通过 `pnpm check:aws-admin-business-evidence`；缺失回执不得以本地测试替代。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-ESG-02（P1 / 管理后台后端），依赖 BE-ESG-01（已交付：telemetry_hourly/daily、esg_daily_summary、esg_calculation_versions）、AUTH-01、DOM-03 |
| 数据边界 | 仅查 RDS 聚合表；原始数据审计查询与 RDS 聚合查询分离（原始报文归档查询属 BE-ARC 通道，不在本 API 混入）；不提供第三方核证结论；不长期托管导出文件 |

## 2. 端点与关键设计

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/admin/esg/overview` | report:read | 最近聚合窗口（各表 scope 内最新 bucket）+ ACTIVE 计算版本 |
| `GET /esg/hourly` / `/daily` | report:read | 小时/日汇总（时间列 bucketStart/bucketDate） |
| `GET /esg/reports` | report:read | 设备提交 Report（+reportType 封闭枚举 CYCLE/HOURLY/DAILY；时间列 periodStartTime） |
| `GET /esg/daily-summary` | report:read | ESG 日汇总（完整率 + calculationVersionId） |
| `GET /esg/calculation-versions` | report:read | 计算版本（全局元数据，无租户维度） |
| `POST /esg/exports` | export:create（SuperAdmin/Auditor/CustomerAdmin） | 202 异步入队；筛选快照冻结 + Customer scope 强制；审计 esg.export.create |
| `GET /esg/exports/{exportId}` | report:read | 状态/rowCount/短期 URL；跨 Customer → 404；URL 签发记审计 esg.export.download |

**筛选**：customerId（平台）/siteId（经设备归属解析）/deviceId/日期范围；列表键集游标分页（id ASC）。

**CSV Schema**（[csv.ts](../../apps/cloud-api/src/admin/esg/csv.ts) `ESG_CSV_SCHEMAS`）：四个数据集封闭列集合，列名与查询 DTO 字段一致；RFC 4180 转义；Decimal 归一；确定性行序（id ASC）。

**异步导出 + Export Worker**：`processEsgExportJob(s)`（PENDING→PROCESSING 条件更新并发兜底 → 复用查询 Service 同源 `buildEsgWhere`（过滤结果与 CSV 行数一致由同源保证）→ CSV → `ExportStorage.put` → `ExportUrlSigner.sign` 900s 短期 URL → COMPLETED/FAILED）。生产 Composition Root 已绑定 S3 存储、签名与定时 Worker。

**短期 URL 过期语义**：详情读取时 `urlExpiresAt <= now` → 不返回 `downloadUrl` 且 `urlExpired=true`（过期后不可用；S3 层过期由部署层签名器保证）；过期/未完成读取不产生下载审计。错误码不新增（复用 CT-05 目录）。

**租户隔离**：Customer 角色列表/导出快照强制所属 Customer；导出详情跨 Customer → 404；计算版本为全局元数据全角色可读。

## 3. 验收基准与证据（vitest + PGlite）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 最近聚合窗口/小时/日/Report/完整率/计算版本查询 | overview（最新 bucket + ACTIVE 版本）；hourly 筛选与 metrics 聚合值；reports reportType 筛选；daily-summary 完整率与版本引用 | ✅ |
| 按 Customer/Site/Device/日期过滤 | customerId/siteId（设备归属解析）/日期范围逐项断言；非法 reportType → 400 | ✅ |
| 过滤结果和 CSV 行数一致 | 同筛选下 list 行数 === CSV 数据行数（表头与封闭 Schema 断言） | ✅ |
| Customer 隔离通过 | 列表显式跨 Customer 参数被强制覆盖；导出详情跨 Customer 404；CustomerViewer 导出 403 | ✅ |
| 下载 URL 过期后不可用 | 时间前进过 urlExpiresAt → downloadUrl=null、urlExpired=true、无下载审计 | ✅ |
| 导出有审计 | esg.export.create（创建）+ esg.export.download（URL 签发读取）各 ≥1 条 | ✅ |
| 契约一致性 | 响应字段与 OpenAPI 封闭一致（summary/report/overview/export）；错误码对齐 CT-05；模块无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-esg-api.test.ts`（覆盖全部端点、202/404、筛选参数、Schema 封闭与枚举、$ref 可解析）。

## 4. 未决风险

- S3 存储、900s URL 签名、生命周期清理与定时 Worker 已完成生产接线；目标 AWS 的对象、过期 URL、清理和卡死任务恢复仍须通过独立回执 Gate；
- 导出无并发/频率限制（RATE_LIMITED 未启用；如需限流另起任务）；
- overview 的 site/device 维度不支持（最近窗口按 customer scope；站点/设备粒度由各列表接口覆盖）；
- CSV 大结果集全量内存聚合（导出口径要求行数一致；超大数据量需流式化，另起任务）。
