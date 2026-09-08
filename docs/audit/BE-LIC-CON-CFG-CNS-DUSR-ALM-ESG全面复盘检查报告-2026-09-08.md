# BE-LIC / CON / CFG / CNS / DUSR / ALM / ESG 全面复盘检查报告

- 检查日期：2026-09-08
- 检查范围：`BE-LIC-01`、`BE-CON-01`、`BE-CON-02`、`BE-CFG-01`、`BE-CNS-01`、`BE-CNS-02`、`BE-DUSR-01`、`BE-DUSR-02`、`BE-ALM-01`、`BE-ALM-02`、`BE-ESG-02`，共 11 项
- 事实源：`docs/管理后台开发任务清单.md` 第 3、4、10 节，冻结决策及当前源码、Schema/Migration、OpenAPI、测试、生产组合根、CDK 和 Git 工作区
- 检查方法：逐项验收矩阵、实现与契约交叉核对、PGlite/Vitest、REST 契约测试、生产路由负向探针、异步 Worker/IaC 追踪、全仓 Gate

## P0 整改复核（2026-09-08）

当前状态：报告所列 P0 生产可达性问题已在本地实现并验证，`B-01`、`B-02`、`B-03`、`H-02`、`M-01`、`M-03`、`M-05` 的 P0 部分关闭。原始审计结论保留为整改前快照；P1/P2 问题和目标 AWS 证据边界没有被本次 P0 修复覆盖。

| 关闭项 | 修复结果 | 本地证据 |
|---|---|---|
| `CLOSED-P0-01` 管理 API 可达 | 56 个目标 operation 全部进入 `DELIVERED_OPERATIONS`，生产 Lambda 实例化 9 组 Handler，Router 完整分派并解码路径参数 | Runtime Gate 与 OpenAPI 双向一致：95 operations；56/56 组合根路由测试通过 |
| `CLOSED-P0-02` License 生产密钥 | CDK 创建 KMS 加密的 Secrets Manager 随机签名密钥，API 仅获最小读取权；冷启动只在内存解析 | CDK asset/IAM 测试、cloud-api/infra typecheck 与 build 通过 |
| `CLOSED-P0-03` ALM Business Notifier | 新增 EventBridge 每分钟 Lambda；接 SES v2 与 HTTPS 精确主机白名单 sender；FAILED 重试先以 lease token 原子领取 | 业务通知 PGlite 测试通过；CDK 17 Lambda、11 Rule、独立执行角色与真实 asset 断言通过 |
| `CLOSED-P0-04` ESG Export Worker | 新增每分钟 Lambda、`esg-exports/` 独立 S3 权限/预签名器/1 天生命周期；PENDING 与过期 PROCESSING 均使用 lease/token/attempt 领取 | ESG 10 tests、Migration 漂移检查、CDK synth Gate 通过 |

本次复核限制：目标 AWS 部署、SES 身份、真实 Webhook、API Gateway/Cognito/RDS/S3 运行回执仍为 **NOT RUN**；仓库级 `pnpm typecheck` 被本次范围外的未提交 Admin Web/OTA 类型错误阻断，因此不能把本地 P0 关闭表述为生产环境已验收。

## 一、任务完成概况

### 1.1 结论

**严格实际完成率：0/11 = 0%，Gate 结论：FAIL。**

11 项均已有源码和自动化测试，定向业务测试 15 files / 133 tests、REST 契约测试 29/29 均通过；但这些结果只证明库内模块可独立运行，不能证明任务已交付：

1. 本范围 9 份 OpenAPI 共声明 56 个 API operation，`DELIVERED_OPERATIONS` 与管理 Lambda 组合根覆盖 **0/56**；代表路径实测均返回 404。
2. `BE-ALM-02` 只有可注入发送端口的库内函数和 PGlite 测试，没有 Lambda 入口、1 分钟调度、SES/HTTPS adapter 或 IAM 接线。
3. `BE-ESG-02` 只有库内 Export Worker，没有生产入口、触发器、S3/签名器或对象生命周期接线。
4. License 的公开契约与前端使用 `OTA`，领域与业务实现使用 `OTA_UPDATE`；按公开契约提交的合法请求实测返回 400。
5. 全仓 `pnpm verify` 在 lint 阶段失败；目标 AWS 部署与运行验收为 **NOT RUN**。

因此，本报告不把“文件存在”“局部测试通过”“OpenAPI lint 通过”或“CDK 可 synth”计作严格任务完成。

### 1.2 完成率分层

| 统计口径 | 结果 | 说明 |
|---|---:|---|
| 源码/Schema/OpenAPI/测试材料存在 | 11/11（100%） | 11 项均有相应模块和定向测试 |
| 定向本地业务测试 | 11/11（100%） | 15 files / 133 tests PASS |
| 目标 REST 契约文件 | 9/9（100%） | 9 files / 29 tests PASS；`BE-ALM-02` 无 REST API 交付物，`BE-DUSR-02` 复用 Device User/Sync 契约 |
| 生产 API 可达 | 0/10（0%） | 56/56 operation 未登记、未路由，代表请求均为 404 |
| 生产异步能力可运行 | 0/2（0%） | ALM 通知与 ESG 导出均无生产 Worker 接线 |
| 全仓质量 Gate | 0/1（0%） | `pnpm verify` 在 lint 阶段因 9 个错误失败 |
| 目标 AWS 运行验收 | 0/11（0%） | 无与当前提交对应的可复核回执，状态为 NOT RUN |
| **严格任务完成** | **0/11（0%）** | 任一必需入口/验收基准未闭合即不计 PASS |

分类规则：

- **PASS**：需求、领域实现、持久化、契约、负向测试、生产组合根和任务验收基准全部闭合。
- **CONDITIONAL**：主路径已可交付，仅剩不阻塞功能的外部证据或运维边界。
- **FAIL**：必需入口不可达、核心契约不一致，或必需 Worker 未接线。

本轮 11 项均属于 **FAIL**；这不否定已完成的库内实现，而是区分“实现材料”与“可交付完成”。

## 二、完成情况明细统计

| 任务 | 已确认实现与当前证据 | 未闭合项 | 结果 |
|---|---|---|---|
| `BE-LIC-01` | 七态状态机、历史/审计、`LICENSE_CHANGED` 与 DEC-016 领域归档、并发唯一索引、签名及 2 层测试存在 | 8 个 API operation 无生产入口；公开 `OTA` 请求被实现拒绝；签名算法/密钥管理仍标为暂定；写请求未按封闭 Schema 拒绝未知字段 | **FAIL** |
| `BE-CON-01` | CRUD/激活/续约/终止/evaluate、唯一编号、日期、If-Match、审计、最小权限 contact 及 PGlite 测试存在 | 8 个 API operation 无生产入口；写请求未严格拒绝未知字段；30 天即将到期窗口仍是暂定业务值 | **FAIL** |
| `BE-CON-02` | 可关联列表、批量绑定/解绑、历史、同 Customer 校验、DB 排他约束、全成全败和不联动 License 测试存在 | 5 个 API operation 无生产入口；写请求封闭性未由真实 Handler 保证 | **FAIL** |
| `BE-CFG-01` | DEC-018 四字段、范围/默认值/分钟单位、不可变版本、按设备/型号发布、`CONFIG_CHANGED`、旧版查询和 Sync 消费测试存在 | 7 个 API operation 无生产入口；创建/版本/发布 Handler 会忽略 OpenAPI 未声明字段 | **FAIL** |
| `BE-CNS-01` | 两种耗材映射、0～100、乱序防护、24h stale、unknown/null、多条件筛选、联系人最小权限及测试存在 | 查询 operation 无生产入口；任务开发文档仍残留 DEC-008“待冻结”旧结论 | **FAIL** |
| `BE-CNS-02` | 创建/列表/详情、四态状态机、If-Match、开放申请幂等、DB 部分唯一索引、租户隔离和审计测试存在 | 6 个 API operation 无生产入口；写请求未严格拒绝未知字段 | **FAIL** |
| `BE-DUSR-01` | 创建/修改/停用/分配/撤销、版本、Customer 隔离、`USERS_CHANGED`、查询脱敏和 PGlite 测试存在 | 7 个 API operation 无生产入口；未知请求字段仍会被忽略 | **FAIL** |
| `BE-DUSR-02` | Argon2id v19/m32768/t3/p1、16-byte salt、32-byte hash、PHC、固定向量、不同 salt、管理 DTO 脱敏和 Sync `passwordHash` 均有测试 | 生成器的管理写入路径依赖未接线的 `BE-DUSR-01`；尚无目标环境端到端复验 | **FAIL** |
| `BE-ALM-01` | Alarm 查询/确认/清除、Event/Tamper 查询、筛选/游标、幂等状态变化、租户隔离和 Critical 领域事件测试存在 | 6 个 API operation 无生产入口；处理请求未严格拒绝未知字段 | **FAIL** |
| `BE-ALM-02` | Critical/非 Critical、投递记录、内容白名单、幂等键、失败重试及上游事件测试存在 | 无生产 Lambda/调度/发送 adapter；并发重试在外部发送前没有领取权，可能重复邮件/Webhook | **FAIL** |
| `BE-ESG-02` | 聚合/Report/完整率/计算版本查询、Customer/Site/Device/日期过滤、CSV 同源查询、URL 过期语义和审计测试存在 | 8 个 API operation 无生产入口；无生产 Export Worker/S3/签名器；PROCESSING 无租约恢复 | **FAIL** |

### 2.1 本地已通过的验证

- 定向业务/领域测试：15 files / 133 tests PASS。
- 9 份目标 REST 契约测试：29/29 PASS。
- 目标后端源码与测试 ESLint：PASS。
- `@fdp/cloud-api` typecheck、build：PASS。
- `pnpm openapi:check`：PASS；仅证明文档合法且 bundle 新鲜。
- `pnpm check:schemas`、`pnpm check:migrations`、`pnpm check:sensitive-sinks`：PASS。
- `infra/test/app-stack.test.ts`：1 file / 34 tests PASS；模板中未出现 ALM 业务通知或 ESG 导出 Worker，不能作为二者接线证据。
- `pnpm check:runtime`：显示 39 operations 一致，但其硬编码目标文件不包含本范围 9 份 OpenAPI，受 M-01 影响。

### 2.2 关键负向探针

1. 将 9 份目标 OpenAPI 与 `DELIVERED_OPERATIONS` 逐 operation 对比：**56 MISSING / 0 DELIVERED**。
2. 对生产 `createAdminRoute` 调用以下代表路径：License POST、Contract GET、Consumable GET、Alarm GET、ESG Overview GET，结果 **5/5 返回 404**。
3. 以 OpenAPI 合法值 `entitlements=[REMOTE_CONTROL, OTA, ESG_REPORTING]` 调用真实 License Handler：返回 **400 VALIDATION_FAILED**。
4. 向 `LicenseCreateRequest` 注入 OpenAPI 禁止字段 `certificatePem`：真实 Handler 返回 **201**，证明请求 Schema 未失败关闭。
5. 全仓搜索 `dispatchPendingNotifications`、`retryFailedDeliveries`、`processEsgExportJobs`：除定义、测试和文档外无生产 runtime/IaC 调用。
6. 链接检查：本范围 11 份开发文档中，8 份共有 **34 个失效相对链接**。

## 三、问题清单及风险分析

### 3.1 优先级统计

| 级别 | 数量 | 当前处置含义 |
|---|---:|---|
| 阻塞级 | 3 | 未关闭前不得声称任务已交付 |
| 高危 | 3 | 涉及源契约互操作、通知重复副作用或目标环境证据 |
| 中危 | 5 | 会造成 Gate 假绿、请求契约漂移、任务卡死或安全方案未冻结 |
| 低危 | 3 | 参数与文档治理缺口 |
| **合计** | **14** | H-03 是证据缺口，其余均有当前代码/配置证据 |

### 3.2 阻塞级

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| B-01 | LIC/CON/CFG/CNS/DUSR/ALM/ESG / Admin Runtime | 9 份 OpenAPI 的 56 个 operation 全部不在生产路由事实表；`lambda-entry.ts` 未实例化本范围 Handler，`createAdminRoute` 无分派分支 | 10 项 API 能力部署后均为 404；DUSR-02 也缺少可创建/轮换验证值的管理入口 |
| B-02 | `BE-ALM-02` | 业务通知只有库内 dispatcher/retry；没有 Lambda entry、≤1min EventBridge、SES/HTTPS sender、最小 IAM 或部署配置 | Critical 告警不会自动生成/发送业务通知，1 分钟验收基准无法成立 |
| B-03 | `BE-ESG-02` | ESG Export Worker 未接 runtime/CDK；未授予导出前缀 S3 权限，也无 URL signer 与对象清理策略 | 导出任务即使能创建也会永久停留 PENDING，无法得到 CSV 或短期 URL |

### 3.3 高危

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| H-01 | `BE-LIC-01` / 源契约 | OpenAPI、Device Sync 和前端使用 `OTA`；`packages/domain/src/license.ts` 与业务测试使用 `OTA_UPDATE`。合法公开请求实测 400，成功响应也会暴露内部码 | License 创建主路径与设备/前端不互操作；OTA Entitlement 无法按正式契约配置 |
| H-02 | `BE-ALM-02` / 重试并发 | `retryFailedDeliveries` 先查询全部 FAILED，再直接调用外部发送，发送前没有原子 claim/lease；两个 Worker 可同时发送同一 delivery。发送成功后、状态提交前崩溃也会再次发送 | 重复邮件/Webhook、客户误报和外部副作用放大；“重试不重复通知”只在串行测试成立 |
| H-03 | 全范围 / 目标 AWS 证据 | 未找到与当前提交绑定的 API Gateway→Lambda→RDS、Cognito 角色/租户、通知发送、S3 导出及 URL 过期回执 | 无法证明真实 AWS 运行性；结论必须保持 **NOT RUN**，不得由 mock、PGlite 或 synth 代替 |

### 3.4 中危

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| M-01 | Runtime Gate | `scripts/check-delivered-runtime.mjs` 仅检查 14 个硬编码 OpenAPI 文件，不包含本范围 9 文件，因此在 56 个 operation 全缺时仍报告“39 operations 一致” | 生产接线检查假绿，后续可继续把未路由 API 误记为已交付 |
| M-02 | LIC/CON/CFG/CNS-02/DUSR/ALM/ESG / 请求验证 | OpenAPI 写请求普遍 `additionalProperties:false`，目标 Handler 只挑已知字段，未复用严格对象解析；License 注入 `certificatePem` 实测仍 201 | 客户端与服务端契约漂移；错误或敏感字段不会在写入前失败关闭，契约测试无法发现 Handler 漂移 |
| M-03 | `BE-ESG-02` / Worker 恢复 | ESG job 从 PENDING 条件更新为 PROCESSING 后无 lease、claim token、attempt count；批处理只扫描 PENDING | Worker 在领取后崩溃会使任务永久卡死；与同仓 Activity Export/Replay 的可恢复租约标准不一致 |
| M-04 | 全仓质量 Gate | `pnpm verify` 在 lint 阶段以 9 errors 失败，涉及 admin-web 的 Device Operate、Device Users、ESG、OTA 文件 | 任务清单完成定义要求 lint/typecheck/测试 Gate；当前仓库不能形成可发布绿灯。未提交 OTA 改动属于用户工作区，本报告未修改 |
| M-05 | `BE-LIC-01` / 签名安全 | HMAC-SHA256、规范化载荷和 `signingKey` 均在源码/OpenAPI/开发文档中标为暂定；生产 Lambda 也无对应密钥环境变量或 KMS/Secrets 接线 | 即使补路由仍无法安全签发 License；方案变化会影响 DB、Sync 和设备验签兼容性 |

### 3.5 低危

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| L-01 | `BE-CON-01` | `EXPIRING_SOON` 固定为 30 天，但代码、OpenAPI 和开发文档均承认是暂定值，未进入版本化决策 | 状态筛选和续约提示可能随业务确认而改变，产生数据/前端口径漂移 |
| L-02 | `BE-CNS-01` / 决策文档 | DEC-008 与策略文件已 frozen@1.0.0（20%/15%/24h），开发文档仍称正式名称和阈值待冻结；决策登记历史 note 也残留 pending 话术 | 审计者和后续开发可能误判冻结状态，重复发明参数或绕过正式策略 |
| L-03 | 本范围开发文档 | 8 份文档使用从 `docs/dev` 出发的 `../apps`、`../packages`、`../contracts` 链接，实测 34 个目标不存在；正确层级应从仓库根多退一级 | 交付物不可导航，追踪矩阵人工复核成本增加，易引用错误文件 |

### 3.6 风险归纳

1. **可交付性风险最高**：核心代码停留在库内，生产 API 与异步入口没有闭合。
2. **契约互操作风险**：License 的 `OTA`/`OTA_UPDATE` 分叉是已复现的真实主路径失败，不是文档措辞问题。
3. **副作用一致性风险**：通知幂等键只能防重复建行，不能防并发 Worker 或“发送成功、状态未提交”造成的重复外发。
4. **证据风险**：局部测试、OpenAPI lint、Runtime 白名单 Gate 和 CDK synth 均可能各自为绿，但不能组合成目标 AWS 验收。

## 四、整改建议

### P0：恢复生产可达性

1. 将 56 个目标 operation 纳入唯一 `DELIVERED_OPERATIONS` 事实表；在 `lambda-entry.ts` 实例化 License、Contract、Contract Device、Configuration、Consumable、Consumable Request、Device User、Alarm、ESG Handler，并在 `createAdminRoute` 逐 operation 分派与安全 decode 路径参数。
2. 为 56 个 operation 增加 API Gateway 事件→JWT→生产 Router→真实 Handler 的组合根测试；每项至少覆盖成功、鉴权、Customer scope、If-Match/输入失败和 404。
3. 新建 ALM Business Notifier Lambda：原子领取事件/投递、接 SES 与受约束 HTTPS sender、每分钟调度、最小 IAM；把 dispatch 与 retry 都纳入生产入口测试。
4. 新建 ESG Export Lambda：接独立 S3 前缀、预签名器、短生命周期和每分钟触发；PROCESSING 使用 lease/token/attempt 并支持过期认领恢复。

### P1：关闭跨层与并发缺陷

5. 以源契约 `OTA` 为 wire code，在管理 API 输入/输出边界显式执行 `OTA`↔内部存储码映射，或全层迁移为 `OTA`；增加 OpenAPI 合法请求→真实 Handler→响应 Schema 的端到端测试，禁止业务测试继续绕过 wire code。
6. 为 ALM delivery 增加状态 `PROCESSING`、lease token/expiry 与条件更新；并发发送前先领取。对 Email/Webhook 优先使用提供方幂等键，记录 provider request ID，以收敛发送后崩溃窗口。
7. 对目标写 Handler 统一使用严格对象 Schema/解析器；未知字段、非对象 body、错误类型必须在任何 DB/KDF/外部副作用前返回 400。真实成功与错误响应都反向校验 OpenAPI bundle。
8. 冻结 License 签名算法、规范化载荷、密钥作用域/轮换/验证兼容策略，使用 Secrets Manager/KMS 或经批准的签名服务接线；禁止把共享签名密钥作为普通配置硬编码。

### P2：恢复 Gate 与文档可信度

9. 把 Runtime Gate 的 OpenAPI 目标改为显式、可审查的完整已交付 manifest，或从正式 bundle 生成；新增负测：任一正式 operation 未接线必须使 Gate 失败。
10. 修复当前 admin-web lint/typecheck/test 问题后完整运行 `pnpm verify`。本次后端整改不得覆盖现有 OTA 工作区改动，应由其所有者独立收敛。
11. 将 Contract 30 天窗口纳入版本化决策；同步修复 DEC-008 旧话术与 34 个失效链接。
12. 在隔离 AWS 测试环境生成与待发布 `sourceCommit` 绑定的真实回执：56 API 正/负路径、五角色与跨 Customer、并发 If-Match、通知 1 分钟/重试幂等、ESG CSV/S3/URL 过期与清理。仓库 Gate 应对缺失或提交不匹配的回执失败关闭。

## 五、Gate 结论与工作区边界

- 本范围定向业务、契约、后端 lint/typecheck/build、Schema、Migration、Sensitive Sink 与 IaC 测试：**PASS**。
- 生产 API/异步组合根：**FAIL**。
- 全仓 `pnpm verify`：**FAIL**（lint 9 errors，未继续执行后续阶段）。
- 目标 AWS 运行验收：**NOT RUN**。
- 最终严格结论：**0/11，FAIL / NOT ACCEPTED**。
- 本报告只新增审计 Markdown；未修改或覆盖工作区已有的 Admin Web/OTA 文件。
