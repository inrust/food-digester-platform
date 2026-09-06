# IAC / AUTH / SEC P1 整改记录（2026-09-05）

## 1. 整改结论

依据《IAC-AUTH-SEC 全面复盘检查报告》的 P1 建议，本轮完成 M-01～M-05 的代码、迁移、负向测试与本地合成验证，P1 范围完成率为 **5/5（100%）**。

本结论只关闭报告中的五个中危问题。AUTH-04 真实 AWS IoT 授权验收仍按既有决定延期至具备隔离 AWS 测试账号的开发后期，不阻塞当前本地开发进程，也不以本地测试替代实网回执。

## 2. 完成情况明细

| 问题 | 整改内容 | 验收证据 | 状态 |
|---|---|---|---|
| M-01 Lambda Runtime | 仓库基线升级到 Node.js 24.12；同步 `engines`、`.nvmrc`、`@types/node`、锁文件、Lambda `nodejs24.x` 与开发文档 | Node v24.12.0；pnpm 10.20.0；全仓 typecheck、build 通过；CDK synth 0 warning | CLOSED |
| M-02 Assertion Gate | 统一收集 IAM Policy、ManagedPolicy、Role 内联 Policy、KMS KeyPolicy；识别 `*`/`service:*` 与通配 Resource；拒绝 KMS 数据面通配 Principal；新增 CDK warning Gate | 实际模板通过；Policy/ManagedPolicy/Role/KeyPolicy 与 CDK warning 负向样例通过；非本地 execute-api 配置缺失负测继续通过 | CLOSED |
| M-03 Runtime Wiring | 管理 API 组合根始终重新验证 Authorization Bearer JWT；2026-09-06 进一步补齐真实 Onboarding 管理路由、RDS Secret 解析和 CDK `NodejsFunction` ESM 资产打包，API Lambda 不再部署 501 占位代码 | JWT 伪造/越权负测通过；方法/路径路由负测通过；模板断言 `Code.S3Bucket` 存在且 `ZipFile` 不存在；真实 bundle 与 synth 通过 | CLOSED |
| M-04 Expiry Recovery | 恢复状态机先持久化意图，AWS 撤证成功后才事务清密文；2026-09-06 补齐 certificateId→已批准申请反查、Secrets Manager/KMS/AWS IoT 生产适配器及 EventBridge sweeper 真实资产包 | AWS 撤证失败保留密文并可重试；certificateId 组合根反查后完成撤证、清包与重签；模板证明五分钟调度目标不是 501 占位函数 | CLOSED |
| M-05 Commit Hook | `confirmPackageDelivery` 支持外部事务客户端；证书包确认与 Onboarding Token 核销合并为同一事务，并强制检查两个条件写结果 | 第一写点冲突不核销 Token；第二写点冲突回滚证书包清理 | CLOSED |

## 3. 关键变更与风险控制

- 新增数据库 Migration `20260905210000_certificate_recovery_state`，并通过 Schema 快照与 PGlite Migration 漂移检查。
- 恢复任务使用五分钟处理租约；进程在 `RECOVERY_IN_PROGRESS` 中断后，后续扫描可回收过期租约继续执行。
- 过期包查询不再物理删除密文；密文只在 AWS 撤证完成后的数据库事务内清除。
- KMS 管理面改为显式管理动作，不再依赖默认 `kms:*` KeyPolicy；证书包数据面仍只允许确定性 API Lambda role 条件。
- API 与证书恢复 Lambda 均由 CDK 从 TypeScript 入口构建 ESM 资产包；其余尚未完成业务实现的 Worker 仍保留显式 501 占位边界。
- API 与 sweeper 分别使用确定性的最小权限角色；证书包 KMS Key Policy 只允许这两个部署时已知的 Principal，其他 Lambda 角色保持隔离。
- RDS 凭据在 Lambda 冷启动时从 Secrets Manager 读取并只在内存中编码为 Prisma 连接 URL；AWS IoT 适配器覆盖建 Thing、签发、Policy/Thing 附加与撤证。

## 4. 验证结果

执行环境：Node.js v24.12.0，pnpm 10.20.0。

| 验证项 | 结果 |
|---|---|
| P1 专项：模板、组合根、Provisioning、Status、SecurePackage、Sweeper | 7 files / 67 tests PASS；新增恢复与原子事务场景复跑 16/16 PASS |
| 全仓 Vitest | 90 files / 759 tests PASS |
| Contracts | 270/270 PASS |
| lint / format / typecheck / build | PASS |
| boundaries / schemas / migrations / evidence / secrets / sensitive sinks | PASS |
| CDK synth warning Gate | PASS，0 warning |

该轮结束时完整 `pnpm verify` 曾被 OpenAPI 重复 operationId 阻断：`prototype-planned-api.json` 与正式 `admin-media-api.json`、`admin-ota-campaign-api.json` 分别重复 `listMedia`、`createOtaCampaign`。该历史限制已于 2026-09-06 通过移除被正式契约接管的 planned 路由并重新生成 bundle 关闭；Scripts 恢复 80/80 PASS。

## 5. 后续事项

1. 部署阶段执行 Cognito/JWKS、API Gateway 与 EventBridge 真实集成验收并保存回执。
2. 具备隔离 AWS 测试账号后执行 AUTH-04 IoT 实网允许/拒绝矩阵并保存清理回执；该项保持延期登记，不改变本轮 P1 关闭结论。

## 6. M-03 / M-04 生产接线补强（2026-09-06）

本次补强关闭了“核心逻辑存在但 CDK 仍部署 501 占位函数”的证据缺口。新增验证结果：

| 验证项 | 结果 |
|---|---|
| AWS clients、cloud-api、infra typecheck | PASS |
| 组合根 / Provisioning / Sweeper / AWS 适配器专项测试 | 6 files / 20 tests PASS |
| CDK 模板与真实 ESM bundle | 1 file / 28 tests PASS；API 与 sweeper 均为 S3 asset，0 个内联占位 |
| 全仓回归 | Vitest 95 files / 787 tests PASS；Contracts 280/280 PASS；build、format、boundaries、sensitive sinks、secrets PASS |
| OpenAPI Gate（2026-09-06 追加复验） | 已移除正式契约已接管的两个 prototype planned 路由；bundle 已重新生成；Scripts 80/80 PASS |

真实 AWS IoT 授权矩阵、API Gateway/Cognito 联调和 EventBridge 实际运行回执仍按既有授权延期至 AWS 集成阶段；本地代码与可合成部署资产已经闭环，不把延期回执表述为已完成。
