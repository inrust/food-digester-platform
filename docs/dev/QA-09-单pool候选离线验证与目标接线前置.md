# QA-09 单 pool 候选离线验证与目标接线前置

2026-10-07。候选入口为 `createAdminPreconnectCandidate`，仅供显式离线调用；现有 Lambda 继续调用 `createPrismaClient`，没有候选环境变量、CDK context 或 Actions 参数。默认关闭，不开展 AWS 操作。

后续更新：默认关闭的Admin hook/部署输入/阶段Gate已完成离线实施，详见[当前手册](QA-09-Admin-hook与C0-C1复验手册.md)。以下记录保留本任务原始离线验证时点，不能当作已执行目标部署。

## 所有权与失败策略

候选持有一个 Prisma client。其 ObservedPrismaPg 创建实际 ObservedPgPool 时向所有权端口发布该 pool；端口不创建 pool、不读取 Prisma 私有字段。pool 必须 max=1，保留 connectionTimeoutMillis=5000、idleTimeoutMillis=10000。准备借出连接并立即 release，不执行 SQL，驱动固有握手仍可能发生。

调用 prepareAuthenticated 后，公开 $connect 的引擎分支与实际 pool 的 checkout 分支重叠；两路均结算后才允许调用方执行账号查询。并发调用共享一个准备 Promise。成功只缓存当前 adapter generation；dispose 立即使该代失效，旧 pool 的延迟回调不能使新代就绪。准备失败清除单飞，后续显式请求可重新尝试准备；没有业务 SQL 自动重试。两路同时失败时固定选择原引擎错误；仅 checkout 失败时保留其原错误；dispose 后成功结算返回 PRECONNECT_GENERATION_INVALIDATED。引擎尚未发布 pool 就失败时直接保留原错误，不留下 readiness 等待者。

checkout 成功后 release 恰好调用一次；checkout 失败不 release；release 异常作为准备失败。没有额外 JS 超时或 SQL 探针；网络 checkout 由原 pg 5000ms 超时负责。离线测试断言超时配置及拒绝传播，未测实际网络超时。引擎准备沿用公开 $connect，没有新增超时承诺。

`db-authenticated-preconnect` 记录 OPERATION_SETTLED / OPERATION_FAILED 和安全错误枚举；不认领 db-first-connection。后续业务 checkout/query 保留独立阶段。引擎阶段 PASS 只表明引擎分支结算，不能代表整体准备成功、账号可用或物理冷启动。准备 Promise 成功也不代表连接此后不会失效。

## 可重复离线检查

先使用仓库 Node 24.12 / pnpm 10.20 环境：

```sh
pnpm exec vitest run packages/database/test/authenticated-preconnect.test.ts apps/cloud-api/test/admin-preconnect-candidate.test.ts packages/database/test/client-preparation.test.ts packages/database/test/observed-pg.test.ts apps/cloud-api/test/admin-user.test.ts
pnpm verify
```

真实生成 Prisma client 配合受控 pg driver 验证单 client/pool、懒 PrismaPromise、batch/interactive transaction、release、disconnect/reconnect 和业务失败不重试。测试 router 要求已验证 JWT 和合法 JSON 后才进入准备；无效 JWT/JSON checkout=0，账号查询仍逐请求执行。既有真实 PGlite 用户状态测试单独验证 DISABLED、INVITED 并发停用、条件激活及审计事务；不能把 fake driver 的空结果当作真实账号语义，也不能称为候选已接入生产 hook 的证据。

## 下一阶段前置

下一任务先准备默认关闭、仅 test/pool1 的 Admin hook 接线和同 SHA C0/C1 可重现输入，以及适配预连接阶段的严格目标关联 Gate。必须保留每次账号状态查询、缺失用户 bootstrap、INVITED 激活事务；不能使用已就绪缓存跳过账号检查。部署前重新完成离线认证/账号状态/事务组合测试和完整 verify。C0/C1必须固定相同的公开引擎准备模式，仅切换单pool预连接，避免将引擎开启差异混作候选收益。

目标启用前分别核对 CI/部署、19 实际工件、配置和预算；C0 清理完成后才能 C1。静态预算63≤70仍不能替代 AWS 内实际连接峰值核验。限定原业务/采样预算，不制造冷启动；比较顶层 client/Gateway/REPORT/应用耗时及业务/清理，不能将嵌套阶段相加。缺冷保留 NOT_OBSERVED，收益与 P95 仍 NOT_RUN。本轮不增加 IAM/KMS、容量、目标探针或部署入口。
