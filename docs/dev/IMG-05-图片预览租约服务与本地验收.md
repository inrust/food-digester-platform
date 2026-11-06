# IMG-05 图片预览租约服务与本地验收

2026-11-06，基于本地提交 098a5141 完成共享存储端口、租约申请与续租、释放、设备状态查询，以及授权失效钩子。本地模块验收为 PASS。生产共享存储和持锁鉴权适配器、生命周期写入口接线按 IMG-08 交付，整体预览后端阶段 G1 为 PARTIAL。

实施依据为 [接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md) 和 [P0 并发设计](./IMG-03-图片预览临时存储与并发设计.md)。本批初始工作区干净，分支 main，已有一个未推送的 P0 提交。本批也按用户要求只创建本地提交。

## 代码交付

| 文件 | 内容 |
|---|---|
| [storage.ts](../../apps/cloud-api/src/live-image/storage.ts) | CONTROL 数据结构、强一致快照读取、revision/authEpoch 双条件 CAS 端口，以及持锁鉴权端口 |
| [service.ts](../../apps/cloud-api/src/live-image/service.ts) | LiveImageLeaseService，包括续租、释放、设备查询和内部授权封闭及重置 |
| [handler.ts](../../apps/cloud-api/src/live-image/handler.ts) | 框架无关租约与设备查询 Handler，统一 data/meta、204、错误码、no-store 和 Retry-After |
| [index.ts](../../apps/cloud-api/src/live-image/index.ts) | 模块导出，同时从 cloud-api 现有源码入口导出 |
| [live-image-leases.test.ts](../../apps/cloud-api/test/live-image-leases.test.ts) | 服务与 Handler 的本地测试，使用共享 CAS 测试存储和读写锁测试鉴权实现 |

### 存储及租约语义

存储端口强制要求独立快照和原子 CAS，创建采用不存在条件。CONTROL 保留单调 revision 与 authEpoch，失效和重新开启都不能回绕。服务没有缺省内存后端，调用方必须提供共享存储及持锁鉴权依赖。测试存储只存在于测试文件。

租约用 actorId 与规范化 viewerId 两个独立字段标识。UUID 大小写统一转小写，设备 ID 保持原样。先剔除逻辑过期租约，再计算续租与设备数量限制。已有查看者共享 streamId，新流只在没有有效租约时生成。单设备最多 16 个查看者，已有租约可以续租。释放只能移除自身租约，重复或过期释放返回 204。最后释放清空 streamId 与帧水位，使后续新流与旧帧隔离。

设备查询无 CONTROL 时返回 IDLE，不创建记录。存在有效租约时返回 ACTIVE，activeUntil 取所有有效租约的最大截止。到期判定使用当前时间，记录尚未物理清理也会返回 IDLE。

CAS 冲突最多尝试 5 次，每次重新进入鉴权锁、读取快照和取得当前时间。已失效角色、证书、设备状态、白名单或客户归属均按当前权威上下文处理。存储冲突耗尽或未知依赖错误响应 503，错误体使用固定安全文本。申请新租约超限返回 429 及 Retry-After。

### 授权失效协议

withRead 必须在当前用户及设备共享锁内刷新身份和权限，锁持续到存储调用完成。Service 再校验 media:read、设备可见范围、Customer 分配、能力开关、生命周期及运行状态，不能用请求携带的旧角色代替刷新后的角色。

内部 fenceAuthorization 的 invalidate 分支在 withExclusive 中递增 revision 和 authEpoch、封闭 CONTROL、清空租约和水位，随后执行可选的权威状态变更回调。生产适配器必须把此回调绑定到相同数据库事务。回调失败时，数据库可以回滚，但共享存储保持封闭。reset 分支供可信集成显式重新读取权威状态后启用，并再次递增 epoch。客户变更时旧 Customer 的 CONTROL 与当前上下文不匹配也会拒绝访问。

withExclusive 的锁范围、数据库事务绑定和依赖超时由 IMG-08 具体适配器落实。真实生命周期、分配、证书、角色和白名单写入入口也须接入该协议。当前代码仅以必选端口规定并验证这一调用顺序。

## 本地检查结果

| 检查 | 结果 |
|---|---|
| IMG-05 专项 Vitest | PASS，31/31 |
| 专项加 Media、管理员初始化和设备 Lambda 组合根回归 | PASS，4 个文件、68/68，包含上述 31 项 |
| P0 摄像头策略、并发模型和图片 API 契约 | PASS，22/22 |
| cloud-api typecheck 与 build | PASS |
| 变更 TS 文件定向 ESLint 和 Prettier | PASS |
| check-delivered-runtime | PASS，现有 129 个生产操作与契约一致 |
| check-boundaries、check-secrets、git diff --check | PASS |

专项测试验证两个服务实例的首次并发申请、同一查看者重试、最后名额竞争、续租与释放两种提交顺序、租约过期后新流、CAS 冲突重试时钟与角色刷新、跨客户访问、挂起退役及能力禁用、证书撤销、写锁等待在途读者、失效后重开、权威事务失败保持封闭，以及响应 Schema。

```bash
node_modules/.bin/vitest run apps/cloud-api/test/live-image-leases.test.ts apps/cloud-api/test/media.test.ts apps/cloud-api/test/admin-runtime-initialization.test.ts apps/cloud-api/test/device-lambda-composition.test.ts
/opt/homebrew/bin/pnpm --filter @fdp/cloud-api typecheck
/opt/homebrew/bin/pnpm --filter @fdp/cloud-api build
node --import tsx --test contracts/domain/camera-interaction-policy.test.ts contracts/domain/live-image-concurrency.test.ts contracts/rest/device-image-api.test.ts
node scripts/check-delivered-runtime.mjs
node scripts/check-boundaries.mjs
node scripts/check-secrets.mjs
```

### FAIL 历史和后续验证

| 状态 | 事项 | 处理 |
|---|---|---|
| FAIL → PASS | 未分配客户的 Customer 查看请求初版测试期望 403，实际按设备不可见返回 404 | 修正测试，与设备可见性约定一致；设备自身查询仍为 403 |
| FAIL → PASS | 测试钩子清除与 exactOptionalPropertyTypes 不一致 | 将可清除钩子类型明确包含 undefined，类型检查通过 |
| FAIL → PASS | 错误码映射整理时自动替换丢失字符串引号 | 修复后重新格式、编译和运行专项及回归测试 |
| NOT_IMPLEMENTED | DynamoDB 生产适配器、PostgreSQL 持锁鉴权适配器与权威写入口集成 | IMG-08 前完成，当前测试覆盖端口协议与服务逻辑 |
| NOT_RUN | 真实 DynamoDB 条件请求、跨服务失败、多实例、锁等待与超时 | 具体适配器交付后逐项验证 |
| NOT_RUN | 新路由公开域名、AWS mTLS、新资源部署、真机与性能 | 后续接线与目标验收阶段 |
| NOT_RUN | 全量 pnpm verify、完整 cloud-api 测试集、前端和 IaC 新资源验证 | 本批执行定向服务、契约、构建与旧入口回归 |

当前无 IMG-05 本地开发阻塞项。G0 继续有效，G1 保留 PARTIAL，新预览路由在 OpenAPI 中继续为 planned。

下一可执行任务是 IMG-06，基于本批 CONTROL 的 revision、authEpoch 和 streamId 设计帧、去重及控制水位的联合条件提交端口，再实现 JPEG/Base64 校验与帧上传。DynamoDB 与持锁鉴权生产适配器的真实验证保持单独证据。
