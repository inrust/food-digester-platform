# IMG-21 MC01 受控工具

这是独立工具源码，未接入应用或 CDK 部署。Writer 和 Verifier 都导出真实 Lambda `handler`，缺少可信配置时拒绝执行。没有 AWS CLI、HTTP 管理入口、任意 SQL/Prisma 操作、设备生命周期修改或自动业务重试入口。

本地命令（仓库根目录）：

```sh
pnpm exec tsc -p tools/img21/tsconfig.json
pnpm exec eslint tools/img21
pnpm exec prettier --check tools/img21
pnpm exec vitest run --config tools/img21/vitest.config.mts
node tools/img21/build.mjs
```

`build/img21-mc01/` 生成两个 ESM 包、完整 esbuild 输入清单和 SHA256。SDK 从现有 aws-clients 包解析，共享包直接指向源码，不新增 workspace、不改锁文件或应用构建入口。依赖版本和实际输入以锁摘要及构建清单为准。Verifier 产物检查实际输出字节的依赖来源，不允许数据库、DynamoDB、Cognito 或应用代码进入其运行代码。测试可引用既有云端 signer 进行正向对照，Verifier 运行代码不引用 signer。

构建包**未附带 run-manifest.json，不能直接用于目标验收**。MC02 需要按审批渲染各自固定的 `/var/task/run-manifest.json`，部署配置只注入该文件的 SHA256，且核对真实数字版本。调用者不能通过 event 指定配置、事实、SDK port、路径或密钥。`approvalRef` 是受信发布配置的一部分，普通字符串或本地构建不产生审批权限。版本发布/固定配置的绑定流程由 MC02 实现并验证；期望版本与真实版本不符时当前代码会拒绝执行。

## Writer

`contracts.ts` 定义封闭 manifest/request。固定测试账号、区域、Pool、Secret、两张表名，窗口严格为完整 UTC instant，时长最多90分钟。应用与工具 Commit 分别记录，不将旧应用 G3 作为新工具认证。

运行条件：数字版本 ARN/版本同时匹配、AWS_REGION 匹配、两个 LIVE_IMAGE 表名均存在且精确匹配、FDP_DB_POOL_MAX=1。真实 DB Secret 经现有 resolver 在 Lambda 内读取；实际 DB 客户端必须经 createPreviewAwarePrismaClient 包装。Writer只读 Cognito 两个固定用户名的 metadata/groups，创建、密码、MFA、组、租户属性及禁用由后续协调步骤完成，本工具不获取相关写权限。

| action           | 请求附加字段                                   | 行为                                                                                                                                                        |
| ---------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEED_PROVISIONER | 无                                             | 验证新建 Cognito 身份、单 PSA 组、无租户、无任何保留租约；创建 INVITED 用户及角色，记录 run 所有权                                                          |
| BIND_DEVICE      | deviceId                                       | 要求 PSA 正常首次登录后 ACTIVE；验证实际客户/站点、四项 API 审计、Onboarding 审批人、CSR/实际 PEM 公钥与指纹及唯一当前证书；客户中仅一站点/一设备；绑定一次 |
| SEED_VIEWER      | 无                                             | 从绑定获取唯一 customer；正常 Cognito 属性必须匹配；创建 INVITED/CustomerViewer/单客户全站点 scope                                                          |
| ENABLE_PREVIEW   | deviceId, expectedAuthEpoch                    | PSA/Viewer 当前 DB 与 Cognito 身份、角色、scope 有效；设备/证书可用；代次一致；仅该设备 allowlist upsert                                                    |
| DISABLE_PREVIEW  | deviceId, expectedAuthEpoch                    | 当前所有权、PSA 权限和代次仍一致；不因设备挂起或证书撤销而拒绝自身关闭；不手动改生命周期                                                                    |
| DISABLE_IDENTITY | userId；绑定后还需 deviceId, expectedAuthEpoch | Cognito 身份需已由协调器禁用；只停用账本内身份，禁止外部保留租约/漂移 scope；先 Viewer 后 PSA，保留最后非停用 PSA 不可删除/停用的不变量                     |
| READ_OPERATION   | 无                                             | operationId 指向原操作；只读自身收据与必要 CONTROL/SQL 状态，可在窗口结束后查询；实际 Invoke 仍需有效 IAM 授权，不因此开放窗口外业务写                      |

公共字段 runId、manifestHash、operationId、action 必填；operationId 为64位小写 hex。READ_OPERATION 仅携带公共四字段，不复制原写请求的 deviceId/expectedAuthEpoch。action 不适用的字段、未知字段、调用者的 facts/approved/sql/data/where/角色等全部拒绝。预览初次启用的 expectedAuthEpoch 必须由受控读取确认，不能猜测或自动重试。

两个 PG 事务：先保存 IN_PROGRESS 意图，再执行业务写与 COMMITTED 收据。现有 authority 包装器自动按 barrier → 行锁 → CONTROL CAS 协议工作；账本使用 audit_logs 的确定性主键，不新增表。事务内保存完整规范请求 Hash、不可变 run 绑定、前置和已关闭 CONTROL 的 fencedAuthEpoch。最终恢复后的代次仅作为读取观察返回，不能宣称 PG+DDB 原子提交。

- 同 operationId 同 Hash 重用；异 Hash 冲突。旧成功收据重读不会重新启用或改写 CONTROL。
- 已确认 callback 抛错：业务回滚，收据标 ROLLED_BACK；成功收据与业务均不可部分提交。
- reservation/COMMIT 回执丢失、未执行的 IN_PROGRESS、rollback 标记失败：UNKNOWN，只查收据及事实，不自动再次执行业务。原操作留在 IN_PROGRESS 时重复请求也不能启动写入。READ 返回 NOT_FOUND 不等于自动获得重做授权。
- SQL 已提交且观察到 CONTROL 仍关闭：SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED，保留 SUCCESS 收据并另写恢复观察，不伪造 SQL 回滚。若 CONTROL 读取失败或当前状态无法证明，则返回 UNKNOWN，并明确 SQL_COMMITTED_CONTROL_OBSERVATION_UNAVAILABLE/STATE_UNPROVEN，不宣称预览关闭。显式恢复必须使用新的受控操作、当前代次并重新鉴权，不提供自动恢复或任意重放按钮。
- 无保留租约的用户停用不要求制造额外 CONTROL fence；有保留租约时验证真实关闭及代次增加。即使过期租约仍留在 CONTROL 中，也按现有包装器的实际规则检查，禁止误触他设备。

用户/角色变更仍需要现有 CONTROL 全表范围 GetItem 元数据读取；写权限只能在 MC02 按实际 UUID 分区限制，不授予 PAYLOAD。代码不替代未来真实 IAM AccessDenied 验证。PG 权限、原生竞争、Cognito 与 PG 间的外部状态变化不由本地夹具证明，授权事实最终依赖每次事务内 PG 读取及正常 Cognito 状态对账。

## Verifier

独立运行包只读 License Secret 的**指定 ARN + VersionId**，单次 SDK 尝试，不尝试 AWSCURRENT 或历史 key，不读取 DB、CONTROL、Cognito 或设备私钥。窗口、候选、工具、数字函数版本、run、serial/model、device/customer/cert、licenseId/version、snapshotEtag、nonce/期限精确匹配后才读 key；异步读取后再检查一次，返回前再检查期限。

DEC-020 HMAC 仅签六字段，不签外层 version/status/ETag。因此 Verifier 的独立 manifest 除 verifierBinding，还必须有 verification={licenseId,licenseVersion,snapshotEtag,expiresAt}，由后续受信步骤在取得真实最新 Sync 快照后固定，期限最多落在请求时点后5分钟和审批窗口内。没有该配置则拒绝读取 Secret。status/effective 是该固定快照的声明，验签不能替代目标授权有效性/快照来源检查，不能把外层布尔值当作独立签名事实。

Writer 的 manifest/root 不能因发布 Verifier 而改写。Verifier 使用独立的 manifest Hash/配置及版本，绑定到同一 run 和真实不可变设备信息；生成新快照/轮换许可证时重新生成并发布对应的 Verifier 配置，不能修改原 Writer 账本摘要。MC02 需验证这项短期发布流程与窗口预算，不能复用过期快照或只更新输入版本。

输入严格限定为 LicenseInput；wire entitlement 排序、完整 UTC instant、规范 v1/Base64URL 和 HMAC timingSafeEqual 均验证。每次只返回绑定元数据与 SHA256，不输出 Key、签名原文或许可原文。Buffer 在 finally 清零；SDK/JS 不可变 SecretString 无法保证物理擦除。nonce 为32字节 hex，仅关联短期响应，不宣称跨实例全局一次性。当前工具不发送 Sync VERIFIED，不自动启用设备。

## 边界

本地测试使用应用的全量 migration 在 PGlite 内构造临时库、真实 Prisma/authority 包装器、合成 key 与 SDK command ports。夹具中的设备/用户激活与审计用于模拟正常业务 API 的已有事实，不是 Writer 可执行的额外动作。PGlite 单后端并发不证明 RDS 多连接锁或原生 DynamoDB CAS。

MC02 的独立 IaC、权限增量、真实 role/边界、连接余量、目标 Secret 读取、数字版本与 manifest 发布和短期 snapshot 绑定均待完成。目标版本等价接收仍由 MC03 审查实现；旧 strict 规则保持不变。目标准备、恢复窗口及 G4 CF01/02/03 仍 NOT_RUN；App/真机不作为云端 Gate 前置。
