# IAC / AUTH / SEC P1 整改记录（2026-09-05）

## 1. 整改结论

依据《IAC-AUTH-SEC 全面复盘检查报告》的 P1 建议，本轮完成 M-01～M-05 的代码、迁移、负向测试与本地合成验证，P1 范围完成率为 **5/5（100%）**。

本结论只关闭报告中的五个中危问题。AUTH-04 真实 AWS IoT 授权验收仍按既有决定延期至具备隔离 AWS 测试账号的开发后期，不阻塞当前本地开发进程，也不以本地测试替代实网回执。

## 2. 完成情况明细

| 问题 | 整改内容 | 验收证据 | 状态 |
|---|---|---|---|
| M-01 Lambda Runtime | 仓库基线升级到 Node.js 24.12；同步 `engines`、`.nvmrc`、`@types/node`、锁文件、Lambda `nodejs24.x` 与开发文档 | Node v24.12.0；pnpm 10.20.0；全仓 typecheck、build 通过；CDK synth 0 warning | CLOSED |
| M-02 Assertion Gate | 统一收集 IAM Policy、ManagedPolicy、Role 内联 Policy、KMS KeyPolicy；识别 `*`/`service:*` 与通配 Resource；拒绝 KMS 数据面通配 Principal；新增 CDK warning Gate | 实际模板通过；Policy/ManagedPolicy/Role/KeyPolicy 与 CDK warning 负向样例通过；非本地 execute-api 配置缺失负测继续通过 | CLOSED |
| M-03 Runtime Wiring | 新增管理 API Lambda 组合根，始终从 Authorization Bearer Token 调用 `createCognitoAuthenticator`，不读取或透传事件中的 `actor`/authorizer claims | 有效 JWT 生成 ActorContext；无 JWT 的伪造 actor/claims 返回 401；低权限签名 JWT 加伪造高权限 claims 仍返回 403 | CLOSED |
| M-04 Expiry Recovery | 为证书增加 `RECOVERY_REQUIRED`、`RECOVERY_IN_PROGRESS`、`RECOVERY_FAILED`、`RECOVERY_COMPLETED` 状态、尝试次数与租约时间；先持久化恢复意图，AWS 撤证成功后才在事务中清密文；失败保留密文并可重试；定时器改为扫描并调用恢复入口 | AWS 撤证失败注入后为 `RECOVERY_FAILED`、密文保留；再次调用成功撤证、清包并重签；批处理单条失败不阻断后续项 | CLOSED |
| M-05 Commit Hook | `confirmPackageDelivery` 支持外部事务客户端；证书包确认与 Onboarding Token 核销合并为同一事务，并强制检查两个条件写结果 | 第一写点冲突不核销 Token；第二写点冲突回滚证书包清理 | CLOSED |

## 3. 关键变更与风险控制

- 新增数据库 Migration `20260905210000_certificate_recovery_state`，并通过 Schema 快照与 PGlite Migration 漂移检查。
- 恢复任务使用五分钟处理租约；进程在 `RECOVERY_IN_PROGRESS` 中断后，后续扫描可回收过期租约继续执行。
- 过期包查询不再物理删除密文；密文只在 AWS 撤证完成后的数据库事务内清除。
- KMS 管理面改为显式管理动作，不再依赖默认 `kms:*` KeyPolicy；证书包数据面仍只允许确定性 API Lambda role 条件。
- Lambda 组合根已提供可执行、可测试的可信边界；IAC 当前仍使用任务清单既定的占位 Handler，实际构建打包与 AWS 部署联调属于后续部署阶段。

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

完整 `pnpm verify` 仍被本轮范围外、在当前 HEAD 已存在的 OpenAPI 重复 operationId 阻断：`prototype-planned-api.json` 与正式 `admin-media-api.json`、`admin-ota-campaign-api.json` 分别重复 `listMedia`、`createOtaCampaign`。因此 scripts 为 75/78，三个失败均来自同一 OpenAPI 重复根因；本轮未擅自修改 CT/BE 契约范围。

## 5. 后续事项

1. 在独立契约整改中移除已经转正式契约的 prototype planned 路由并重新生成 bundle，使完整 `pnpm verify` 恢复通过。
2. 部署阶段将管理组合根接入实际 Lambda 构建产物，并执行 Cognito/JWKS 与 API Gateway 集成验收。
3. 具备隔离 AWS 测试账号后执行 AUTH-04 IoT 实网允许/拒绝矩阵并保存清理回执；该项保持延期登记，不改变本轮 P1 关闭结论。
