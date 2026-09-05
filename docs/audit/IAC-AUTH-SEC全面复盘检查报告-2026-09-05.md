# IAC-01、AUTH-01～04、SEC-01 全面复盘检查报告

> 后续整改：P0 见《IAC-AUTH-SEC-P0整改记录-2026-09-05.md》；P1 的 M-01～M-05 已关闭，见《IAC-AUTH-SEC-P1整改记录-2026-09-05.md》；P2 证据与文档已完成，见《IAC-AUTH-SEC-P2整改记录-2026-09-05.md》。本报告正文保留整改前审计快照。

## 1. 任务完成概况

| 项目 | 结论 |
|---|---|
| 检查范围 | `docs/管理后台开发任务清单.md` §7：IAC-01、AUTH-01、AUTH-02、AUTH-03、AUTH-04、SEC-01 |
| 检查日期 | 2026-09-05（Asia/Shanghai） |
| 代码基线 | `56ab99c`（`main`，检查开始和报告写入前除本报告外工作树干净） |
| 检查口径 | 需求规格、技术对接、功能边界、交付物、验收基准逐项核对；代码存在、单元测试通过、真实集成验收三者分开计数 |
| 严格完成率 | **2/6，33.3%**：AUTH-01、AUTH-03 PASS；IAC-01、AUTH-02、AUTH-04、SEC-01 FAIL |
| 原子检查点覆盖率 | **43/50，86.0%**；该数值表示已实现工作量，不代替严格任务验收 |
| 打开问题 | **14 个**：0 阻塞级、7 高危、5 中危、2 低危 |
| 综合 Gate | **FAIL / NOT ACCEPTED** |

本次检查不沿用六份开发文档中的历史“均已交付”结论，而是以当前源码、当前决策、当前测试和负向探针重新判定。专项测试 26 个文件、179/179 通过；全仓 Gate 的底层命令全部通过，合计 1020/1020 测试通过。绿色测试证明现有断言成立，但不能关闭未被断言覆盖的部署有效性、分布式限频、真实 AWS IoT 拒绝、证书包物理过期销毁和 KMS 权限边界问题。

### 1.1 判定规则

- **PASS**：任务的核心内容、技术对接、交付物和全部验收基准均有当前可复验的实现或证据。
- **FAIL**：至少一个明确验收基准未满足，或存在可绕过安全控制/阻止可信部署的高危缺陷。
- 原子检查点按任务清单中的独立要求拆分；部分实现不计为“完全满足”，但在任务明细中保留其已完成工作。
- 未执行任何 AWS 部署、真实凭据调用或生产变更；缺少真实云端证据的条目保持未验收。

## 2. 完成情况明细统计

### 2.1 汇总

| 任务 | 原子检查点 | 已满足 | 覆盖率 | 严格状态 | 主要未满足项 |
|---|---:|---:|---:|---|---|
| IAC-01 | 10 | 8 | 80.0% | **FAIL** | 默认 Device API 不是强制 mTLS；synth 存在 CloudFormation 字段约束警告且断言未失败关闭 |
| AUTH-01 | 8 | 8 | 100% | **PASS** | 组件级验收通过；真实 Lambda 的 JWT→actor 适配仍属集成边界 |
| AUTH-02 | 8 | 7 | 87.5% | **FAIL** | 默认限频为进程内、仅 Token 指纹维度，无法满足多实例下 Token/IP 联合保护 |
| AUTH-03 | 9 | 9 | 100% | **PASS** | 组件及 Retired 过渡链路均有数据库集成测试；真实 API Gateway 握手属部署/QA 边界 |
| AUTH-04 | 6 | 5 | 83.3% | **FAIL** | 没有清单明确要求的 AWS IoT 允许/拒绝集成测试 |
| SEC-01 | 9 | 6 | 66.7% | **FAIL** | 86400 秒上限未失败关闭且无到期清扫；日志/Trace 未全链接线；KMS 解密主体唯一性未得到证明 |
| **合计** | **50** | **43** | **86.0%** | **2/6 PASS** | 任何高危问题未关闭前综合 Gate 不得通过 |

### 2.2 IAC-01

已确认的实现：

- `infra/src/stacks/app-dependencies-stack.ts` 已定义 IoT Rule、6 个 SQS、5 个 Lambda、RDS PostgreSQL、5 个 S3 Bucket、3 个 REST API、Cognito、2 个 KMS Key 和独立执行角色，并输出应用配置。
- 资源名带 `fdp-{env}-` 前缀；S3 Block Public Access/TLS/KMS、RDS `PubliclyAccessible=false`、Secrets Manager 动态凭据和主要 IAM 资源收敛均有模板断言。
- `cdk synth` 当前退出 0；`infra/test` 纳入专项 179/179 通过集合。

未通过原因：

- `deviceApiDomain` 是可选配置。默认 synth 明确生成 `DisableExecuteApiEndpoint: false`，Device API 方法为 `AuthorizationType: NONE`，且测试把该状态视为正确；这不能证明 Device 与 Onboarding 的认证入口按 mTLS 失败关闭分离。
- 当前 CDK 校验输出 3 条 `F3031` 描述字段字符集警告：IoT Rule Role 及两个 Security Group 使用中文描述。synth 仍返回 0，但模板未达到无约束违规的可信部署状态。
- 5 个 Lambda 使用已于 2026-04-30 弃用的 `nodejs20.x`；当前仍可创建，但 CDK 已提示 2027-02-01 后禁止创建。

判定：**FAIL**。资源覆盖和 synth 交付基本完成，但安全入口与部署有效性尚未达到严格验收。

### 2.3 AUTH-01

已确认的实现：

- `packages/auth/src/cognito.ts` 使用 RS256/JWKS 校验签名、issuer、`token_use` 和 client 绑定；过期、伪造、错误 issuer/audience/client 统一返回 401。
- 五个角色及平台/Customer 互斥映射、未知组失败关闭、Customer 角色强制 `custom:customer_id`、平台角色忽略外来 customer claim 均已实现。
- `PERMISSION_MATRIX` 集中定义权限；`requirePermission`、`assertCustomerScope`、`withAuthorization` 提供 403 越权和跨 Customer 防护，并把 actor、Customer、IP、User-Agent、requestId 注入可信异步上下文。
- Cognito、权限矩阵、Guard、契约一致性以及下游 Customer scope 用例均已通过当前测试。

边界：生产源码中没有 `createCognitoAuthenticator` 的组合根调用，当前 IAC Lambda 仍是 501 占位 Handler。因此本结论只接受任务清单要求的认证 Guard/Decorator/矩阵组件，不把真实部署链路表述为已验证。

判定：**PASS（组件验收）**。

### 2.4 AUTH-02

已确认的实现：

- Token 使用 32 字节随机值，数据库仅保存 SHA-256；序列号库存绑定、有效期、撤销、核销、跨序列号拒绝和指纹上下文均已实现。
- Onboarding request/status Handler 已接 `withOnboardingAuth`；请求幂等、状态轮询、一次性领取后的 Token 核销均有数据库测试。
- 错误、过期、撤销、已核销、跨序列号和单实例过量请求均有负向测试。

未通过原因：

- `InMemoryRateLimitStore` 只在单进程内计数；每个 Handler 默认新建独立实例，多 Lambda 实例及 request/status 两条链路之间不共享计数。
- 默认键只有 `token:{fingerprint}`；接口允许调用方改成 IP，但不能在默认链路同时执行 Token 和 IP 两套限制。攻击者轮换伪造 Token 即可绕过以 Token 为键的匿名暴力枚举保护。
- 负向探针证明同一 key 在两个独立 store 中可各自通过一次。因此“过量请求均被拒绝”只在单实例测试模型成立。

判定：**FAIL**。

### 2.5 AUTH-03

已确认的实现：

- 从 API Gateway `clientCert` 上下文计算 DER SHA-256 指纹，并以 `device_certificates` 白名单映射证书；CA 链不替代应用白名单。
- 仅 ACTIVE、未撤销且 `notBefore <= now < notAfter` 的证书通过；跨 deviceId 返回 403，成功后注入 device/customer/site/lifecycle context。
- DEC-014 已正确收敛：通用 Device auth 对 Retired 默认 403；仅 Sync 可显式申请 `retiredAccess: SYNC` 且必须处于 72 小时 `PENDING_CONFIRMATION` 窗口；Deactivate 使用独立身份层；确认后证书撤销并全部拒绝。
- PGlite + 全部 Migration 测试覆盖未登记、撤销、过期、未生效、跨设备、Retired 窗口边界、Deactivate 和确认后拒绝。

判定：**PASS（组件及本地数据库集成验收）**。真实 API Gateway mTLS 握手仍属于 IAC/QA 的部署证据，不重复计入 AUTH-03 缺陷。

### 2.6 AUTH-04

已确认的实现：

- `buildDevicePolicy` 生成 4 条 Allow：Client ID=Thing Name、8 个自身上行 Publish、3 个自身下行 Subscribe/Receive；策略资源为字面量 ARN。
- 本地模板和精确匹配求值器覆盖自身允许、跨设备、通配、错误方向、未知类型和非法输入；Topic 与 CT-02 目录保持一致。

未通过原因：

- 仓库没有使用真实 AWS IoT Thing/证书/Policy 的集成套件或验收回执。现有测试明确声明只做本地模拟，并把真实拒绝矩阵推迟到 QA-04。
- AWS IoT 会合并证书、Thing/Thing Group 上附加的策略；单份 JSON 的精确匹配求值不能证明目标环境最终权限集合仍拒绝跨设备和错误方向操作。

判定：**FAIL**。Policy builder 已实现，但清单的云端验收基准未完成。

### 2.7 SEC-01

已确认的实现：

- `SecurePackageService`、AES-256-GCM 信封格式、KMS DataKeyProvider 和本地测试 Key Provider 齐备；数据库只保存密文数据密钥和包密文。
- Onboarding Token/旧设备证书领取资格、单次预留锁、响应提交后销毁、重复领取失败关闭、响应不确定撤证重签路径均有测试。
- 数据库和审计样本没有明文私钥；字段名、PEM、Onboarding Token 和 Bearer 的脱敏函数测试通过。

未通过原因：

- 服务仅要求 `retentionSeconds > 0`，没有强制冻结值/上限 86400；负向探针证明 86401 可成功构造。生产调用仍从任意 `packageRetentionSeconds` 注入，而不是消费 `certificate-package-policy`。
- 没有到期 sweeper。若设备不再轮询或发 Heartbeat，过期密文仍可无限期留库，`packageExpiresAt` 只是逻辑拒绝条件，不能满足“密文保存不超过 86400 秒”。
- `createRedactingLogger` 在生产源码中没有调用；仍有直接 `console.error(...err.message)`。也没有 Trace exporter/attribute 的脱敏接线或全链扫描，因此只能证明脱敏函数，不足以证明错误日志/Trace/审计 0 泄露。
- 模板测试没有检查证书包 Key 的 Decrypt 主体；合成模板的 KeyPolicy 仍含账号 root 的 `kms:* / Resource:*`。当前证据不能支持“解密权限仅限指定 Lambda role”的绝对结论。

判定：**FAIL**。

## 3. 问题清单及风险分析

### 3.1 优先级统计

| 优先级 | 数量 | 对 Gate 的影响 |
|---|---:|---|
| 阻塞级 | 0 | 本次检查不存在缺文件、无法读取或无法继续验证的阻塞条件 |
| 高危 | 7 | IAC-01、AUTH-02、AUTH-04、SEC-01 不得验收 |
| 中危 | 5 | 部署寿命、断言盲区、组合根和异常恢复仍需关闭 |
| 低危 | 2 | 文档可追溯性和历史证据已漂移 |
| **合计** | **14** | 综合 Gate 为 `FAIL / NOT ACCEPTED` |

### 3.2 高危问题

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| H-01 | IAC-01 / CloudFormation | synth 报 3 条 `F3031`：IAM Role、Lambda SG、DB SG 的 Description 不符合目标字段字符集；校验只告警不失败 | 首次部署可能在 CloudFormation 资源校验阶段失败，IAC 无法作为可部署基线 |
| H-02 | IAC-01 / Device API | `deviceApiDomain` 可省略；默认模板保留 execute-api 入口且 Device 方法为 `NONE`，测试还显式接受该状态 | 三类认证入口未失败关闭；配置遗漏会绕过网关 mTLS，只剩应用层缺证书拒绝，且当前占位 Lambda 无该保护 |
| H-03 | AUTH-02 / Rate Limit | 默认进程内 store、仅 Token 指纹维度；多实例、request/status 分离和轮换伪 Token 均可拆分计数 | Onboarding Token 枚举、状态轮询和资源消耗保护可被绕过 |
| H-04 | AUTH-04 / AWS IoT | 只有本地 JSON 精确匹配求值，没有真实 IoT 策略允许/拒绝回执 | 不能证明证书最终附加策略集合会拒绝跨设备、通配和错误方向操作 |
| H-05 | SEC-01 / Package TTL | 允许任意正 `retentionSeconds`，86401 探针通过；没有到期清扫，只有再次 claim/Heartbeat 才销毁 | 私钥密文可能超过 86400 秒长期保留，违反 DEC-003 和任务硬上限 |
| H-06 | SEC-01 / Logging & Trace | 脱敏器仅作为库函数存在，生产代码无 redacting logger 调用且存在直接 `console.error`；无 Trace 脱敏/扫描 | AWS/KMS/解析异常中的 Token、凭据或密钥形态可能进入日志/Trace，0 泄露验收无效 |
| H-07 | SEC-01 / KMS IAM | 测试未断言证书包 Key 解密主体唯一性；KeyPolicy 含账号 root `kms:*`，现有断言只扫描 IAM Role Policy 中的字面 `Action:*` | 无法证明只有 API Lambda 可解密；账号内其他 IAM 授权可能扩大密钥使用面 |

### 3.3 中危问题

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| M-01 | IAC-01 / Lambda Runtime | 5 个函数固定 `nodejs20.x`，CDK 报运行时已弃用，并给出 2027 年停止创建/更新日期 | 新环境部署和后续更新存在确定的寿命截止风险 |
| M-02 | IAC-01 / Assertion Gate | IAM 检查只识别 `Action` 精确等于 `*` 且只收集 IAM Policy；不检查 `kms:*`、KeyPolicy，也不把 CDK validation warning 转为失败 | 模板安全/部署回归可能继续在测试全绿时漏过 |
| M-03 | AUTH-01 / Runtime Wiring | 生产源码没有 `createCognitoAuthenticator` 的调用点；Handlers 直接信任外部注入的 `actor`，IAC API Lambda 仍为占位实现 | 组件测试通过但真实 JWT→ActorContext→业务 Handler 的可信链尚无可执行证据 |
| M-04 | SEC-01 / Expiry Recovery | status 过期分支先 `destroyPackage`，再调用 AWS 撤证/重签；若外部撤证失败，密文已销毁而 DB 仍可能为 PENDING_CLAIM | 设备可永久停留在 PENDING，后续轮询找不到可恢复包，需人工修复 |
| M-05 | SEC-01 + AUTH-02 / Commit Hook | HTTP 提交后的 `confirmPackageDelivery` 与 `markOnboardingTokenUsed` 是两个独立写操作；前者成功、后者失败时无事务/补偿 | 包已销毁但 Token 未核销，状态与一次性交付事实不一致，重试可能长期返回 PENDING |

### 3.4 低危问题

| ID | 所属模块 | 具体表现 | 影响范围 |
|---|---|---|---|
| L-01 | docs/dev | 六份任务文档从 `docs/dev` 使用 `../infra`、`../packages` 相对链接，实际均指向不存在的 `docs/infra`、`docs/packages` | 审阅者无法点击追溯实现与测试，证据可用性下降 |
| L-02 | docs/dev | 文档仍记录 2026-08-27 的 27、29、44、55、14、92 等历史计数；AUTH-01 还写 DEC-012 `pending`，但当前已冻结 1.0.0 | 文档会误导完成状态和当前决策，现有 evidence Gate 未覆盖这六份文档 |

### 3.5 风险结论

- 现有 1020/1020 绿灯主要覆盖组件逻辑和仓库静态规则，不能覆盖 AWS 资源最终合并权限、多实例状态、部署字段约束和时间驱动销毁。
- H-02、H-03、H-05、H-06、H-07 都属于安全控制“默认不失败关闭”；在这些问题关闭前，不应把当前代码部署为对外设备/Onboarding 入口。
- AUTH-01、AUTH-03 的 PASS 是任务组件级结论，不表示 IAC Lambda 打包、真实 Cognito/JWKS、API Gateway mTLS 或生产域名已完成联调。

## 4. 整改建议

### 4.1 P0：关闭高危问题

1. 将 IAM Role/Security Group Description 改为目标服务允许的字符集；在 CI 使用 CDK 默认规则校验并把 CloudFormation validation warning 视为失败，重新 synth 证明 0 警告。
2. 对非本地环境强制提供完整 mTLS 域名配置；Device API 一律 `disableExecuteApiEndpoint=true`。如需本地开发入口，必须通过显式 `allowInsecureDeviceEndpointForLocal` 开关并禁止用于 dev/staging/prod。
3. 为 AUTH-02 实现共享、原子递增且有 TTL 的 RateLimitStore（DynamoDB/Redis 等），对 Token 指纹和可信 source IP 分别执行限频；request/status 共用同一命名空间，并补多实例并发探针。
4. 在隔离 AWS 测试账号创建两台 Thing/证书，附加生成策略，逐项执行自身允许、跨设备、通配订阅、发布下行和订阅上行；保存 AWS IoT 拒绝原因、时间、区域、Policy 版本和清理回执。
5. SEC-01 直接消费 `certificatePackageRetentionSeconds()` / 冻结策略，拒绝任何不等于 86400 的生产配置；增加定时 sweeper，以条件更新领取过期包并执行撤证/重签状态机。
6. 在应用组合根统一注入 redacting logger，并覆盖 Lambda 错误映射、AWS SDK/KMS 错误、审计和 Trace attributes/events；增加跨全部日志/Trace/审计 sink 的 canary 扫描测试。
7. 为证书包 KMS Key 编写明确 KeyPolicy 与模板断言：区分密钥管理主体和数据面 Encrypt/Decrypt 主体，证明除指定 API Lambda 外没有工作负载 principal 可解密，并对 wildcard Action/Resource 做语义扫描。

### 4.2 P1：关闭中危问题

1. 将 Lambda runtime 升级为仓库验证过的 Node.js 24，并同步 `engines`、`.nvmrc`、CDK runtime、锁文件和构建证据。
2. 扩展模板 Gate：校验所有 IAM/ManagedPolicy/Role/KeyPolicy，识别 `service:*` 与通配 Resource；对 CDK warnings、默认 execute-api 和 KMS principal 添加失败样例。
3. 实现可执行的 API Gateway/Lambda 组合根，把 authorizer claims 经 `createCognitoAuthenticator` 或等价可信适配转换为 ActorContext；用伪造 claims/绕过 actor 注入的负向集成测试证明业务 Handler 不可被直接调用。
4. 调整过期恢复顺序与状态机：持久化 `RECOVERY_REQUIRED`/outbox，异步、可重试地完成 AWS 撤证和重签后再清除密文，避免外部调用失败造成不可恢复中间态。
5. 将 package delivery confirm 与 Token 核销合并为同一数据库事务，或使用幂等 outbox/补偿任务；对每个写入点注入失败并验证最终可收敛。

### 4.3 P2：证据与文档

1. 修复六份任务文档相对链接为 `../../infra/...`、`../../packages/...`，更新 DEC-012 状态与当前测试计数。
2. 扩展证据 Gate，至少检查 §7 六份文档的链接、决策状态、命令和计数，避免再次把历史绿灯当作当前验收。
3. 整改完成后重新运行专项、全仓 Gate、CDK 0-warning synth、共享限频并发测试和 AWS IoT/KMS 集成验收，再重新计算 6 项严格完成率。

## 5. 当前复验证据

### 5.1 环境和命令

```text
环境：macOS arm64；Node v24.12.0
代码：56ab99c（main）

CDK：
  ../node_modules/.bin/tsc -p infra/tsconfig.build.json
  infra/node_modules/.bin/cdk synth
结果：exit 0；3 条 F3031 Description warning；5 条 nodejs20.x deprecated warning

专项：
  ./node_modules/.bin/vitest run infra/test packages/auth/test
    packages/aws-clients/test packages/observability/test
    及 Onboarding/Provisioning/Rotate/Retirement/Sync/Deactivate 关键应用测试
结果：26 files，179/179 PASS

全仓 Gate（逐项执行 package.json verify 的底层命令）：
  eslint / prettier / turbo typecheck / OpenAPI check+lint / vitest / contracts test /
  scripts test / turbo build / boundaries / schemas / migrations / evidence / secrets
结果：全部 exit 0；Vitest 693/693 + contracts 254/254 + scripts 73/73 = 1020/1020
```

当前 shell 的全局 `pnpm` 包装器在 `pnpm --version` 阶段无输出卡住，且运行 Node 24 不符合仓库声明的 `>=20.19 <21`，因此本次没有把“`pnpm verify` 命令本身退出 0”作为证据；改为逐项执行其完全对应的底层命令。该环境限制不改变源码问题判定，但在最终关闭 Gate 时应在仓库声明的 Node 20.19.x/pnpm 10.20.0 环境再跑一次原始 `pnpm verify`。

### 5.2 关键负向探针

| 探针 | 当前结果 | 结论 |
|---|---|---|
| 默认 CDK 模板读取 Device RestApi | `DisableExecuteApiEndpoint=false`，方法认证 `NONE` | H-02 可复现 |
| 扫描 synth validation | 3 条 Description、5 条 Runtime warning | H-01/M-01 可复现 |
| 构造 `SecurePackageService(retentionSeconds=86401)` | 成功 | H-05 可复现 |
| 两个独立 InMemoryRateLimitStore 对同一 key 各请求一次 | 两次均成功 | H-03 多实例绕过可复现 |
| 搜索生产 `createRedactingLogger` 调用 | 0 个调用点 | H-06 可复现 |
| 搜索生产 `createCognitoAuthenticator` 调用 | 0 个调用点 | M-03 可复现 |
| 搜索 AWS IoT 集成套件/回执 | 仅本地求值器，测试注释明确推迟到 QA-04 | H-04 可复现 |
| 检查六份任务文档链接与状态 | 实现/测试链接全部断开；DEC-012 状态和计数陈旧 | L-01/L-02 可复现 |

## 6. 最终 Gate

| 任务 | Gate |
|---|---|
| IAC-01 | **FAIL** |
| AUTH-01 | **PASS（组件级）** |
| AUTH-02 | **FAIL** |
| AUTH-03 | **PASS（组件及本地数据库集成级）** |
| AUTH-04 | **FAIL** |
| SEC-01 | **FAIL** |
| **综合 IAC/AUTH/SEC Gate** | **FAIL / NOT ACCEPTED** |

严格完成率为 **2/6（33.3%）**。下一可执行任务应先处理 H-01/H-02 的 IAC 失败关闭和 H-05/H-06/H-07 的敏感材料安全边界，再补 AUTH-02 共享双维限频与 AUTH-04 真实 AWS IoT 验收证据。
