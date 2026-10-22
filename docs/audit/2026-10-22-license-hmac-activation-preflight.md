# 独立 License HMAC 与业务激活：前置核验（2026-10-22）

**目标实测为 `BLOCKED_EXTERNAL_OPERATIONS_AUTHORITY`。独立 License HMAC 验签和 `VERIFIED → Active` 均为 `NOT_RUN`，未完成业务闭环。** 用户确认“运营没有提供”获权验签通道。本轮完成只读环境核验、真实 CSR UUID 格式的工具适配和本地回归；未创建隔离设备，未发送 `VERIFIED`，未读取真实签名密钥，也未部署临时 verifier。

本记录承接 [REST Sync 状态修复与隔离复测](2026-10-22-rest-sync-status-fix-live-test.md) 和 [历史 A2 权限边界](QA-09-A2设备验签与A5可靠性推进-2026-10-13.md)。上一轮仅通过 `RECEIVED` 达到设备生命周期 `Licensed`；管理员将 **License 状态**设为 `Active`、MQTT 自报 `licenseStatus=ACTIVE` 或运行状态 `Active`，均不能证明设备已独立验签或完成业务激活。历史已封存的成功、失败及清理证据保持原样，不升级为本轮结论。

## 云端核验结果

检查时间 UTC `2026-10-22T13:54:09Z`～`13:54:22Z`，北京时间 21:54；范围为测试账号 `065986019555`、新加坡区域 `ap-southeast-1`。

| 项目 | 当前结果 | 证据 |
|---|---|---|
| 调用账号 | 与测试账号一致 | [account.json](evidence/license-hmac-activation-preflight-2026-10-22/account.json) |
| 仓库预期的专用角色 | `fdp-test-qa09-license-verifier-role` 不存在，`GetRole` 返回 `NoSuchEntity`，exit 254；保留原错误 | [dedicated-role.json](evidence/license-hmac-activation-preflight-2026-10-22/dedicated-role.json) |
| 区域 Lambda 清单 | 19 个既有应用函数中未发现独立 verifier；没有把该清单解释为对所有其他服务的穷尽搜索 | [lambda-inventory.json](evidence/license-hmac-activation-preflight-2026-10-22/lambda-inventory.json) |
| 本地执行身份入口 | 配置的三个 profile 为 `esgiot-dev`、`esgiot-infra`、`esgiot-readonly`；profile 名称不构成 Secret 读取授权 | [profiles.json](evidence/license-hmac-activation-preflight-2026-10-22/profiles.json) |
| 运营交接 | 用户明确确认尚未提供获权通道；不将其表述为运营授权回执 | [summary.json](evidence/license-hmac-activation-preflight-2026-10-22/summary.json) |

历史约定由运营负责 IAM/KMS。现有 Admin API 的签名权限不自动授权独立验证任务；不借用该角色建立临时执行器，不导出 HMAC 密钥，不改写数据库生命周期，也不使用服务端签名匹配替代独立验签。下一步交接见 [运营执行材料](evidence/license-hmac-activation-preflight-2026-10-22/operations-handoff.md)。

## 已完成的工具准备

本轮源代码基线为 `dd8c554f7388a11d2532005abd85bb49ab20bdd4`，工作树改动及相关服务端源文件的 SHA-256 记录于 [summary.json](evidence/license-hmac-activation-preflight-2026-10-22/summary.json)。这是源码与本地检查绑定，不是当前部署工件核验；本轮没有重新核验部署版本或运行目标业务。

- [独立验签器](../../scripts/qa09-device-license-verifier.mjs) 保留旧 QA09 夹具范围，新增 `syncprobe-<16 hex>` / `SYNC-<16 uppercase hex>` 的 CSR 设备范围；UUID、序列号、型号和证书指纹必须一致。回执增加固定顺序的绑定摘要。此检查仅证明输入自洽，实际设备归属及证书来源仍需通过真实申请记录、云端只读核对和 mTLS 会话验证。
- [受控 worker](../../scripts/qa09-a2-controlled-worker.mjs) 允许上述 License 输入，保留专用执行角色、精确来源摘要、测试 Secret 和五分钟时效限制。固件签名范围不变。
- [仅 License 的入口](../../scripts/license-hmac-verifier-entry.mjs) 固定应用提交、限制 16 KiB 输入，通过 SDK 获取执行身份，只调用 `LICENSE_VERIFY`；失败输出固定错误，不返回密钥或原异常。它是供运营审阅的准备代码，**没有部署、调用或获权证明**；运行时 SDK 装载与云端调用仍为 `NOT_RUN`。
- 源码包可按交接说明在本地重建，包含四个源文件，未包含 SDK 依赖。包摘要与字节数已记录；它不代表已具备可部署的运行环境。

HMAC 核心实现独立重建 DEC-020 canonical JSON 并使用 `timingSafeEqual`；生产验证代码不导入云端签名器。单元测试使用随机假密钥和本地签名器生成兼容性输入，其结果仅为本地工具证据。

## 本地检查与失败记录

| 检查 | 结果 |
|---|---|
| 定向工具及 License 线协议回归 | 9/9 PASS，包含新增绑定正反例、专用角色/来源/提交/大小约束及既有兼容性回归；[日志](evidence/license-hmac-activation-preflight-2026-10-22/local-tests-attempt-2-pass.json) |
| License Sync 生命周期与快照约束 | 10/10 PASS，使用本地测试数据库及真实 handler；[日志](evidence/license-hmac-activation-preflight-2026-10-22/local-license-sync-tests.json) |
| 首次工具检查 | FAIL：本地根依赖没有 `@aws-sdk/client-sts`，入口顶层 import 导致测试加载失败；改为在运行入口内加载 SDK，纯验证测试无需云 SDK。失败记录保留，[原日志](evidence/license-hmac-activation-preflight-2026-10-22/local-tests-attempt-1-fail.json) |
| 完整脚本回归 | 首次 1456/1459，三个本地 TLS/HTTP 测试因沙箱监听 `EPERM` 失败；允许本地端口后 1459/1459 PASS，断言未改。[首次日志](evidence/license-hmac-activation-preflight-2026-10-22/all-script-tests-attempt-1-fail.json)、[重跑日志](evidence/license-hmac-activation-preflight-2026-10-22/all-script-tests-attempt-2-pass.json) |
| ESLint | 变更的四个脚本通过；[日志](evidence/license-hmac-activation-preflight-2026-10-22/local-eslint.json) |

离线封存核验首次因解析正在重定向写入的自身输出文件而失败；已排除该输出文件并重新核验，未调整目标 Gate。[失败记录](evidence/license-hmac-activation-preflight-2026-10-22/offline-verification-attempt-1-fail.json)保留。

本地数据库测试不访问 AWS，不证明项目 Secret 实际验签、目标 mTLS 确认或云端业务激活。最终仓库脚本回归及格式/敏感信息/链接检查见 [检查回执](evidence/license-hmac-activation-preflight-2026-10-22/final-checks.json)，封存证据可运行同目录的 [离线核验器](evidence/license-hmac-activation-preflight-2026-10-22/verify.mjs) 复核。

## 目标 Gate 与清理

| 用户要求的目标 | 本轮结果 |
|---|---|
| 新隔离设备真实 CSR、审批、发证和分配 | `NOT_RUN`：前置未满足，未创建设备 |
| 目标真实 License 的独立 HMAC 正向/负向验证 | `NOT_RUN`：无获权通道 |
| 同一实际快照的 `RECEIVED → VERIFIED` | `NOT_RUN`：未发送确认请求 |
| 云端生命周期、latest state、历史、审计及幂等读回 | `NOT_RUN_NO_DEVICE_CREATED` |
| 临时设备、证书、Thing、分配、License、用户及验签器清理 | `NOT_REQUIRED_NO_RESOURCES_CREATED`；本轮只读，没有需要清理的云资源，不记作清理实测 PASS |
| 实体固件与生产验收 | `NOT_RUN` |

运营提供获权的现有独立验签通道或完成其审阅的受控部署后，才能按交接材料创建新隔离设备，验证真实密钥对应的签名，再提交相同绑定的确认并核对云端结果。当前无须再次向用户申请 IAM/KMS 权限；本报告不关闭该外部前置。
