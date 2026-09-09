# BE-MED-01、BE-RBAC-01、BE-AUD-01、BE-DASH-01、BE-SET-01 全面复盘检查报告

> 检查日期：2026-09-09
> 检查基线：`cf2cba776ed0d8e9bcf91da660ba834629391740`
> 检查范围：`docs/管理后台开发任务清单.md` 第 10 节中的 `BE-MED-01`、`BE-RBAC-01`、`BE-AUD-01`、`BE-DASH-01`、`BE-SET-01`
> 结论口径：以当前代码、正式 OpenAPI、Migration、生产组合根、负向探针和可复核验收证据为准；历史文档、模块文件存在、mock/PGlite 测试、CDK synth 或全仓 Gate 绿灯均不单独等价于任务交付或目标 AWS 验收。

## 一、任务完成概况

### 1.1 总体结论

**严格实际完成率：0/5（0%），Gate 结论：FAIL / NOT ACCEPTED。**

五项任务均已有领域/服务实现、正式 OpenAPI 和定向测试，定向业务测试 **5 files / 44 tests PASS**，目标 REST 契约 **17/17 PASS**，Media 上行与 IaC 支撑测试 **3 files / 42 tests PASS**；全仓 `pnpm verify` 也通过。但这些材料没有闭合生产交付：

1. 六份正式 OpenAPI 共声明 **15 个 operation**，`delivered-openapi-manifest.json` 与 `DELIVERED_OPERATIONS` 覆盖 **0/15**；生产 Admin/Device Router 代表路径实测 **6/6 返回 404**。
2. `lambda-entry.ts` 未实例化 Media、User/RBAC、Audit、Dashboard、Settings Handler；`device-entry.ts` 也未实例化 Device Media Handler。
3. Media 只有 S3 `HeadObject/GetObject` 元数据验证适配器，没有上传/下载 URL 的生产签名适配器；RBAC 只有 `CognitoAdminPort`，没有 Cognito Admin API 的 AWS 实现与组合根接线。
4. 负向探针复现了 Media 配额竞态、RBAC 最后 SuperAdmin 并发失守、Dashboard 动作授权误报、审计敏感值漏出和封闭请求 Schema 漂移。
5. 未找到绑定当前提交、覆盖这五项 API/角色/租户/S3/Cognito/并发场景的目标 AWS 验收回执；目标环境状态为 **NOT RUN**。

因此，本报告不把“源码存在”“正式契约存在”“局部测试通过”或“全仓 `verify` 通过”计作严格任务完成。

### 1.2 完成率分层

| 统计口径 | 结果 | 说明 |
|---|---:|---|
| 主体源码/Schema/OpenAPI/测试材料存在 | 5/5（100%） | 五项均有对应模块、契约与测试 |
| 定向本地业务测试 | 5/5（100%） | 5 files / 44 tests PASS |
| 目标 REST 契约测试 | 5/5（100%） | 6 份 OpenAPI、15 operations；17/17 tests PASS |
| Media 上行与 IaC 支撑测试 | 1/1（100%） | 3 files / 42 tests PASS；证明上行消费、S3 读取适配与 CDK 模板，不证明 Media REST 可达 |
| 正式 OpenAPI 生产路由 | 0/5（0%） | 15/15 operation 未登记；六条代表请求均为 404 |
| 必需 AWS 业务适配器 | 0/2（0%） | Media URL signer 与 Cognito Admin adapter 均不存在 |
| 任务验收基准无已复现缺陷 | 0/5（0%） | 每项至少存在一个阻塞/高危未闭合项 |
| 目标 AWS 运行验收 | 0/5（0%） | 无与当前提交绑定的完整回执，NOT RUN |
| **严格任务完成** | **0/5（0%）** | 任一必需入口、核心验收基准或目标证据未闭合即不计 PASS |

判定规则：

- **PASS**：需求、实现、持久化/外部适配、正式契约、负向测试、生产组合根和目标验收全部闭合。
- **CONDITIONAL**：生产主路径和任务验收基准已闭合，只剩明确不阻塞主路径的外部证据或运维边界。
- **FAIL**：必需入口不可达、必需外部适配不存在，或核心验收基准存在可复现失败。

本轮五项均为 **FAIL**。

## 二、完成情况明细统计

### 2.1 逐项核对

| 任务 | 已确认实现与当前证据 | 未闭合项 | 结果 |
|---|---|---|---|
| `BE-MED-01` | 上传会话服务、类型/申报大小/Hash/设备状态校验、服务端 Key、Media 上行 Handler、Object/大小/Hash 复核、元数据落库、管理列表/下载授权、DEC-005/009 边界及 PGlite 测试存在；上行 Ingestion 已接 S3 读取 | 3 个 REST operation 无生产路由；无上传/下载 URL AWS signer；配额采用 `count → create`，并发可超额；签名端口不能绑定实际上传大小/Checksum；目标 AWS S3/mTLS/API 验收未执行 | **FAIL** |
| `BE-RBAC-01` | 五角色封闭集、列表/邀请/角色/Scope/停用/重置服务、权限矩阵、自我操作/跨 Customer/串行最后 SuperAdmin 防护、审计及 PGlite 测试存在；响应不返回密码材料 | 6 个 REST operation 无生产路由；无 Cognito Admin AWS adapter；两个 SuperAdmin 可并发互相降级至 0 个；Cognito 先写、DB/审计后写且无补偿；带 `password` 的封闭 Schema 非法请求实测仍返回 201；目标 AWS Cognito/JWT 验收未执行 | **FAIL** |
| `BE-AUD-01` | append-only 数据源、列表/详情、actor/Customer/对象/动作/结果/时间筛选、复合游标、Customer 纵深隔离、只读路由设计和二次脱敏存在；定向测试通过 | 2 个 REST operation 无生产路由；脱敏键规则漏掉 `authorization`、`cookie` 等常见凭据，负向探针原样返回 Bearer Token/Session Cookie；目标 AWS 角色/租户验收未执行 | **FAIL** |
| `BE-DASH-01` | Contract/设备/在线率/License 分布/UTC 当日 ESG/最新告警/最多 10 卡片聚合、四轴分离、Customer scope、稳定排序、空态及固定 10 设备 Fixture 测试存在 | 1 个 REST operation 无生产路由；动作 `allowed` 只检查 actor 权限和设备状态，不检查 BE-CMD-01 必需的有效 License + `REMOTE_CONTROL` Entitlement；无 License 设备实测仍报告 `START allowed=true`；目标 AWS 聚合验收未执行 | **FAIL** |
| `BE-SET-01` | 四个封闭 key、值校验、版本冲突、审计、固定命令/Topic/通知枚举防护及 PGlite 测试存在；`command.confirmation` 已由 Command 服务读取并失败关闭 | 3 个 REST operation 无生产路由；未知请求顶层字段实测被忽略并返回 200；`alarm.thresholds`、`dictionary.displayNames`、`notification.business` 未见运行时消费，更新不能改变对应业务行为；目标 AWS 并发/审计验收未执行 | **FAIL** |

### 2.2 正式接口交付统计

| 契约 | operation 数 | 生产登记 | 代表性实测 |
|---|---:|---:|---|
| `device-media-api.json` | 1 | 0/1 | `POST /api/v1/device/media/upload-sessions` → 404 |
| `admin-media-api.json` | 2 | 0/2 | `GET /api/v1/admin/media` → 404 |
| `admin-user-api.json` | 6 | 0/6 | `GET /api/v1/admin/users` → 404 |
| `admin-audit-api.json` | 2 | 0/2 | `GET /api/v1/admin/audit-logs` → 404 |
| `admin-dashboard-api.json` | 1 | 0/1 | `GET /api/v1/admin/dashboard/overview` → 404 |
| `admin-settings-api.json` | 3 | 0/3 | `GET /api/v1/admin/settings` → 404 |
| **合计** | **15** | **0/15（0%）** | **6/6 代表路径返回 404** |

补充说明：`DELIVERED_OPERATIONS` 当前方法类型只允许 `GET | POST | PATCH | DELETE`，而 RBAC 角色/Scope 与 Settings 更新共 3 个正式 operation 使用 `PUT`；在扩展方法类型并纳入 manifest 前，它们不能进入当前生产路由事实表。

### 2.3 当前验证结果

| 验证 | 结果 | 证据边界 |
|---|---|---|
| 五项业务测试 | PASS：5 files / 44 tests | PGlite + fake ports；不证明 API Gateway/Lambda/AWS adapter |
| 六份 REST 契约测试 | PASS：17/17 | 证明契约结构与 `$ref`；不证明生产路由 |
| Media Ingestion/S3 读取/IaC 支撑 | PASS：3 files / 42 tests | 证明上行核心与 CDK 模板；不证明 Media REST URL signer |
| Runtime Gate 定向测试 | PASS：4/4，112 operations | 只覆盖 manifest 已登记接口；本范围 15 个 operation 被排除在分母外 |
| 全仓 `pnpm verify` | PASS | Vitest 137 files / 1154 tests；Contracts 290；Scripts 111；lint/format/typecheck/OpenAPI/build/boundary/schema/migration/evidence/secrets/sinks/runtime/CDK 通过 |
| 目标 AWS 验收 | **NOT RUN** | 无当前提交回执；不得由上述本地结果替代 |

首次使用系统 `pnpm` 时，版本切换器因离线/签名校验无法取得已签名包而拒绝运行；随后使用本机 Node `24.12.0` 与 `/opt/homebrew/bin/pnpm` `10.20.0` 重跑。该工具链事件未进入产品问题统计。

### 2.4 关键负向探针

1. 将六份正式 OpenAPI 与 `DELIVERED_OPERATIONS` 逐 operation 比对：**15 MISSING / 0 DELIVERED**。
2. 对生产 `createAdminRoute`/`createDeviceApiLambdaHandler` 调用 Media、User、Audit、Dashboard、Settings 六条代表路径：**全部 404**，未触达注入 Handler。
3. Media 每日配额设为 1，同时创建两个上传会话：结果 `fulfilled, fulfilled`，数据库 `sessionCount=2`。
4. 两个仅存的 SuperAdmin 并发互相改为 Auditor：两个操作均成功，最终 SuperAdmin 数可降为 0；串行测试不能覆盖该竞态。
5. Dashboard 对 `licenseStatus=null` 且无 License/Entitlement 的 Active 设备返回 `{command:"START", allowed:true, denyReason:null}`，而 BE-CMD-01 创建命令会在 Entitlement Gate 返回 403。
6. `sanitizeAuditPayload({authorization:"Bearer ...", cookie:"session=...", clientSecret:"..."})` 仅遮蔽 `clientSecret`，前两项原样保留。
7. 向邀请接口加入 OpenAPI 禁止的 `password` 字段：返回 **201**；向 Settings PUT 加入未知顶层字段：返回 **200**。
8. 全仓搜索确认 Media URL signer/Cognito Admin AWS adapter 不存在；`@fdp/aws-clients` 的 Media 生产适配器只有 `HeadObject/GetObject`。

## 三、问题清单及风险分析

### 3.1 优先级统计

| 级别 | 数量 | 当前处置含义 |
|---|---:|---|
| 阻塞级 | 2 | 未关闭前五项均不得声称已交付 |
| 高危 | 6 | 涉及凭据泄露、授权误报、权限治理竞态、配额失守或目标证据缺失 |
| 中危 | 3 | 涉及契约失败关闭、上传资源约束和设置语义空转 |
| 低危 | 2 | 文档可信度与未冻结业务参数治理 |
| **合计** | **13** | 其中 H-06 为证据缺口，其余均有当前代码或可复现探针 |

### 3.2 阻塞级

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| B-01 | 全范围 / REST Runtime | 六份正式 OpenAPI 的 15 个 operation 全部不在 delivered manifest/生产路由；代表请求均返回 404；`PUT` 还不在路由事实表方法联合类型内 | 五项 API 部署后均不可达；所有业务验收主路径被阻断 |
| B-02 | `BE-MED-01`、`BE-RBAC-01` / AWS Adapter | Media 无 S3 Put/Get 预签名 URL adapter，Device/Admin 组合根未实例化 Media；RBAC 无 Cognito Admin API adapter，Admin 组合根未实例化 User Handler | Media 无法创建可用上传/下载会话；邀请、角色/Scope 同步、停用和重置无法在真实 Cognito 执行 |

### 3.3 高危

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| H-01 | `BE-AUD-01` / DOM-03 脱敏 | 敏感键模式未覆盖 `authorization`、`cookie` 等常见凭据；读取侧复用同一脱敏器，探针原样返回 Bearer Token 与 Session Cookie | 一旦上游误写这些字段，审计详情可向 Auditor/SuperAdmin 泄露可重放凭据；“敏感字段永不返回”不成立 |
| H-02 | `BE-DASH-01` / Command 动作 | 卡片动作仅检查 `command:send` 与设备状态门，未复用 BE-CMD-01 的有效 License + `REMOTE_CONTROL` Entitlement 门 | UI 可对实际必然 403 的设备展示可执行动作，造成权限/授权状态误导和失败操作 |
| H-03 | `BE-RBAC-01` / SuperAdmin 不变量 | “最后一个 SuperAdmin”采用事务外 `count` 后再改角色；两个管理员可并发互相降级，探针最终得到 0 个 SuperAdmin | 平台失去任何可管理角色/用户的账号，需要越出正常业务流程恢复 |
| H-04 | `BE-RBAC-01` / Cognito-DB 一致性 | Cognito groups/scope/disable/invite 先执行，DB 与 SUCCESS 审计后提交，失败时无补偿、Outbox 或对账闭环 | Cognito 已生效而数据库/审计未生效，可能出现未审计提权、租户 Scope 分叉或幽灵用户 |
| H-05 | `BE-MED-01` / 配额并发 | 每日配额使用事务外 `count → create`，无条件写、计数器或唯一槽位；quota=1 的双并发探针落库 2 条 | 恶意或重试流量可突破每设备每日配额，放大 S3 成本与处理负载 |
| H-06 | 全范围 / 目标 AWS 证据 | 没有绑定当前 `sourceCommit` 且覆盖 15 API、五角色/跨 Customer、Cognito、S3、竞态和清理的验收回执，也没有本范围专用的失败关闭证据 Gate | 无法证明 API Gateway→Lambda→RDS/Cognito/S3 的真实运行性；发布结论必须保持 NOT RUN |

### 3.4 中危

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| M-01 | `BE-MED-01`、`BE-RBAC-01`、`BE-SET-01` / 请求验证 | OpenAPI 请求体为 `additionalProperties:false`，Handler 只摘取已知字段而不拒绝未知字段；`password` 邀请返回 201、Settings 未知顶层字段返回 200 | 服务端与公开契约漂移；客户端误以为敏感/错误字段生效，且这些字段可能进入网关或外围日志 |
| M-02 | `BE-MED-01` / 预签名上传约束 | `MediaUrlSigner.signUpload` 仅接收 key/expiry，不能绑定声明大小或 SHA-256；客户端可小额申报后上传超大对象，直到元数据阶段才被拒绝，且无本任务清扫器 | 注册会失败但超限对象已占用 S3，形成成本与存储滥用窗口 |
| M-03 | `BE-SET-01` / 设置消费 | `command.confirmation` 已有消费方；全仓未发现 `alarm.thresholds`、`dictionary.displayNames`、`notification.business` 的运行时读取，Notifier 仍读取另一张 Customer 配置表 | 三类设置更新虽返回成功并留审计，但不能改变告警、展示名或通知行为，形成“成功但无效”的管理体验 |

### 3.5 低危

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| L-01 | 开发文档 / 状态陈述 | `apps/cloud-api/src/index.ts` 将 RBAC/Audit/Dashboard 描述为“已落地”，各任务文档也使用“生产代码已接入”等措辞，但正式生产路由与关键 adapter 未闭合 | 审计者和后续开发容易把库内实现误判为可部署交付，降低状态文档可信度 |
| L-02 | `BE-MED-01`、`BE-DASH-01` / 参数治理 | Media 大小/日配额/URL TTL 与连接状态 10 分钟阈值仍标记 provisional，尚未进入版本化冻结决策 | 参数变化可能造成前后端、设备与运营口径漂移；不阻止修复当前接线，但正式发布前需冻结 |

### 3.6 风险归纳

1. **首要风险是不可达**：核心业务文件齐全，但正式接口不在生产事实表，所有五项均停留在库内能力。
2. **安全风险独立于不可达问题**：审计凭据脱敏和 RBAC 不变量即使补完路由仍会失效，不能只做接线整改。
3. **前后端授权口径分叉**：Dashboard 的 `allowed` 不是 Command 最终授权结果，会直接违反“服务端授权结果决定按钮可用性”的项目共同要求。
4. **绿色 Gate 存在范围差异**：`pnpm verify` 的 Runtime Gate 对已登记 112 operations 是真实绿灯，但本范围正式契约未纳入其分母；不能把该绿灯外推为本五项完成。
5. **目标环境仍无证据**：本地 PGlite、fake Cognito/S3、组合根测试和 CDK synth 均不能证明真实 Cognito/S3/API Gateway 行为。

## 四、整改建议

### P0：恢复生产可达性与必需适配

1. 把六份正式 OpenAPI 纳入 `delivered-openapi-manifest.json`，将 `DeliveredOperation.method` 扩展为包含 `PUT`，登记 15 个 operation；在 Admin/Device Router 完成逐 operation 分派和安全路径参数 decode。
2. 在 `lambda-entry.ts` 实例化 Media、User、Audit、Dashboard、Settings Handler；在 `device-entry.ts` 实例化 Device Media Handler。
3. 实现统一 Media S3 生产端口：异步预签名 PUT/GET、限定 Bucket/Key、TTL、Content-Length 范围和校验和；分别授予 Device/Admin Lambda 最小对象级权限。
4. 实现 Cognito Admin adapter（AdminCreateUser、组整体同步、Customer 属性、Disable、Reset），配置最小 IAM；增加 adapter 单测与生产组合根测试。
5. 为 15 个 operation 增加 API Gateway event → 可信身份 → Router → 真实 Handler 的组合根测试；每项至少覆盖成功、无身份、角色拒绝、跨 Customer、非法 body 和 404。

### P1：关闭安全、授权与并发缺陷

6. 扩展统一敏感字段分类，至少覆盖 Authorization、Cookie/Set-Cookie、session、JWT、refresh/access/id token 及常见变体；写入与读取两侧使用同一白名单/结构化投影，并加入嵌套对象、数组、大小写和非标准键负测。
7. 将 Dashboard 动作判定上提为 BE-CMD-01 共用的无副作用授权函数，完整检查 actor permission、Customer scope、设备状态、有效 License 和 `REMOTE_CONTROL` Entitlement；增加“无 License/过期/吊销/无 Entitlement”卡片测试。
8. 用数据库级互斥/约束或串行化事务保护 SuperAdmin 最小基数；加入两个管理员并发互降、并发停用/降级的真实 PostgreSQL 测试。
9. 将 Cognito 与 DB 的双写改为可恢复 Saga/Outbox：持久化意图与审计，再由 Worker 幂等同步 Cognito；或为外部先行操作提供确定补偿与可告警对账。任何中间失败都不得形成有效但未审计的授权变化。
10. 将 Media 每日配额改为条件计数器/唯一槽位或串行化事务中的原子领取；并发 N+1 请求只能成功 N 个。配额应计入尚未完成但已签发的会话。

### P2：恢复契约、设置与证据可信度

11. 所有写 Handler 统一使用严格对象解析器；未知字段、数组 body、错误类型必须在 DB、KDF、Cognito、S3 或审计之前返回 400。永久密码字段要明确失败关闭而非静默忽略。
12. 为 `alarm.thresholds`、`dictionary.displayNames`、`notification.business` 定义并接入唯一消费方；若本版本只交付存储，则调整任务/契约状态，不得把无消费者的设置描述为已生效。
13. 冻结 Media 上传限制与 Dashboard 连接阈值的版本化决策，同步策略、OpenAPI、设备文档和测试。
14. 新增本范围目标 AWS 回执 Gate，绑定精确 `sourceCommit`，覆盖 15 API、五角色/跨 Customer、Cognito 属性与组、最后 SuperAdmin/版本并发、S3 Key/大小/Hash/URL 过期、Dashboard Entitlement、审计脱敏及清理；缺文件或任一探针失败必须非零退出。
15. 修正文档状态：明确区分 `module implemented`、`production wired`、`target verified`；在 P0/P1 关闭前不得使用无边界的“已落地/生产已接入”。

## 五、最终 Gate 结论与工作区边界

- 五项库内服务、正式契约与定向自动化测试：**PASS**。
- 五项生产 REST 组合根：**FAIL（0/15 operation delivered）**。
- Media/Cognito 必需生产适配：**FAIL**。
- 核心负向验收：**FAIL**（配额、RBAC 不变量、审计脱敏、Dashboard 授权、封闭请求均有复现失败）。
- 全仓 `pnpm verify`：**PASS**；仅作为仓库当前已纳入 Gate 范围的旁证，不改变本范围 FAIL。
- 目标 AWS 运行验收：**NOT RUN**。
- **最终严格结论：0/5（0%），FAIL / NOT ACCEPTED。**

本次工作仅新增本审计报告，未修改业务代码、契约、Migration、测试、基础设施或部署状态。
