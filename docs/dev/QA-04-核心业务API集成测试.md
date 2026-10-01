# QA-04 核心业务 API 集成测试

依据[开发任务清单](../管理后台开发任务清单.md#qa-04-建立核心业务-api-集成测试)，依赖全部 P1 管理后台后端任务。套件执行真实 API Handler、权限守卫、业务服务、事务和 PostgreSQL 迁移；提供五角色、双 Customer、状态机、越权、重复请求、If-Match 与审计的本地集成 Gate。

## 执行

```sh
pnpm test:core-api-integration /tmp/qa04-local.json
node --test scripts/core-api-integration.test.mjs
pnpm verify
```

第一条等价于 `node --import tsx scripts/run-core-api-integration.mjs /tmp/qa04-local.json`。CLI 必须指定回执文件；测试、覆盖、源码稳定性或必需场景缺失时覆盖为 FAIL，非零退出。临时 trace/测试报告目录通过 finally 删除。`verify` 已加入此 Gate。

[独立 Vitest 配置](../../qa04-vitest.config.mjs)仅运行[清单](../../scripts/qa04-manifest.mjs)中的核心 API 测试，不新增前端测试。[响应观察器](../../apps/cloud-api/test/qa04-observe.ts)只在此配置加载：调用原生产工厂和原 Handler，保留依赖、输入、输出及错误；记录 area/method/status、角色、Customer、错误码、If-Match 与 replayed。它使用 Vitest 的模块拦截功能增加观测，不替换业务响应。普通仓库测试不加载观察器。

身份使用 ActorContext 测试夹具，AWS/通知/存储等端口使用本地注入，不使用真实 Cognito 用户或生产凭据。不将此证据宣称为 API Gateway、Cognito、RDS 或云端副作用验收。

## 范围与隔离

| 范围 | 接线与验收 |
| --- | --- |
| Onboarding | 审批/拒绝、Provisioning Job、If-Match、并发只有一个成功、审计 |
| Assignment | 首次分配、归属窗口、角色边界、跨 Customer Site 拒绝、重复无新增 |
| Contract/设备关联 | 创建/编辑/激活/续约/终止；批量关联全成或全败、跨 Customer、租期冲突 |
| License | Draft→Issued→Active→ExpiringSoon→Renewed→Active→Expired→Revoked；签名、有效 License 唯一、重复续期 |
| Sync | Assignment/Alias/License/Device Users/Configuration/Operational 快照、证书身份、Retired 待确认时间边界 |
| Suspend/Reactivate/Retire | 双轴状态历史、必要原因/问题解决标志、重复无新增、退役撤销与证书停用端口 |
| Consumable Request | 创建/处理/完成/取消、开放申请幂等、If-Match 冲突、审计 |
| Alarm | 确认/清除、终态拒绝、重复幂等、越权 |
| ESG | 聚合/报告查询、Customer scope、异步导出和短期 URL 的本地端口 |
| Command | 命令矩阵、授权、高风险重认证字段、meta.id 幂等与语义冲突 |
| Audit | 权限、Customer 纵深防御、分页、敏感字段脱敏、只读 |

既有领域文件使用独立 PGlite，应用全部 migration 并在 afterAll 关闭；复用其领域断言，不复制已有状态机测试。[新增集成场景](../../apps/cloud-api/test/qa04-core-api.test.ts)每个场景创建独立 PGlite、随机 `QA04-<标识>` 前缀的两个 Customer/设备，finally 关闭：

1. 五角色对同组租户执行本 Customer/跨 Customer Device 读取、挂起、Audit 查询。权限期望独立写死，未从生产权限矩阵推导。拒绝写入后业务状态、Outbox、状态历史和 SUCCESS 审计不变；审计查询不增加日志。
2. 同一 Contract version=1 的两个真实并发 If-Match 更新：一个 200、一个 409 VERSION_CONFLICT；version=2，SUCCESS 审计一条；旧版本重试无写入。
3. PostgreSQL trigger 拒绝 audit_logs INSERT：挂起返回 500，生命周期、历史、Outbox、审计全部回滚。去掉故障后重试成功；重复请求 replayed=true，不增加历史/Outbox/审计；问题解决后恢复 Active。

## 覆盖 Gate 与回执

[运行器](../../scripts/run-core-api-integration.mjs)要求所有清单文件完整执行且无跳过，18 个关键验收场景不可被无关绿灯测试替代。14 个观测领域（13 个任务领域，加 Device 读取）必须各有真实成功和错误响应；三项跨域证明必须包含五角色矩阵、双 Customer、唯一前缀、清理、并发单赢家、回滚和一次成功审计。401、VERSION_CONFLICT 与 replayed 的真实响应样本均强制存在。

[Gate 测试](../../scripts/core-api-integration.test.mjs)使用明确标注的合成输入验证失败关闭；合成输入不作为集成回执。回执仅来自新进程执行真实测试后的 trace/JSON reporter，记录每个成功测试名称、领域状态/方法计数、关键证明、执行时间和源码 SHA-256。源码运行期间变化则失败。`baselineCommit` 是运行时 HEAD，提交前证据以源码 Hash 绑定，不能冒称为最终提交 SHA。

[本次验收记录](../audit/QA-04-本地验收记录-2026-10-01.md)与[本地回执](../audit/evidence/qa-04-local-api-integration.json)保存精确快照。

目标 AWS 继续使用 [CUS/DEV Gate](../../scripts/check-aws-admin-cus-dev-evidence.mjs)、[核心业务 Gate](../../scripts/check-aws-admin-business-evidence.mjs)、[RBAC/Audit Gate](../../scripts/check-aws-med-rbac-aud-dash-set-evidence.mjs)。缺少隔离环境、真实身份/副作用和 exact-HEAD 结构化回执时保持 **NOT RUN / NO RECEIPT**；本地 Gate PASS 不解除云端验收缺口。
