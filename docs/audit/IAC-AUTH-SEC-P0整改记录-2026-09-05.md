# IAC / AUTH / SEC P0 整改记录（2026-09-05）

## 1. 整改结论

本记录承接 [`IAC-AUTH-SEC全面复盘检查报告-2026-09-05.md`](./IAC-AUTH-SEC全面复盘检查报告-2026-09-05.md) 的 P0 整改建议，记录 H-01～H-07 的本次处置结果。

- H-01、H-02、H-03、H-05、H-06、H-07 已完成代码整改和本地自动化验证。
- H-04 已实现真实 AWS IoT 授权验收工具，但因项目尚未进入 AWS 部署阶段、当前没有隔离 AWS 测试账号，真实云端回执经项目方明确决定延期至开发后期补充。
- H-04 延期不阻塞本次代码提交，但不得据此宣称 AUTH-04 已完成真实 AWS IoT 验收，也不得将当前综合 Gate 表述为生产部署验收通过。

本次进程状态：**P0 本地整改可提交；AUTH-04 云端验收为 `DEFERRED / NOT VERIFIED`**。

## 2. 高危问题处置明细

| ID | 模块 | 本次处置 | 当前状态 | 后续约束 |
|---|---|---|---|---|
| H-01 | IAC-01 / CloudFormation | 将 IAM Role、Lambda Security Group、DB Security Group 的 Description 收敛为目标字段允许字符；重新 synth 后原 3 条 `F3031` 已消失 | 已关闭 | 仍有 6 条 Node.js 20 runtime warning，属于原报告 M-01/P1，不在本次提前整改 |
| H-02 | IAC-01 / Device API | 非 local/test 环境强制完整 mTLS 配置；默认禁用 execute-api；仅 local/test 可显式开启不安全开发入口，并补失败关闭测试 | 已关闭 | AWS 部署阶段补真实 API Gateway mTLS 握手回执 |
| H-03 | AUTH-02 / Rate Limit | 增加 PostgreSQL 原子 UPSERT 共享计数器和到期字段；request/status 共用 Token/IP 命名空间；默认同时执行 Token 指纹与可信 source IP 限频 | 已关闭 | 部署接线必须只传入 API Gateway 可信 `sourceIp`，不得信任客户端自报 Header |
| H-04 | AUTH-04 / AWS IoT | 增加隔离账号验收脚本：创建两台 Thing、两张证书及各自 Policy，双向执行自身允许、跨设备、通配和错误方向拒绝矩阵，输出回执并清理资源 | **延期验证** | 进入 AWS 集成阶段后必须在隔离账号执行并提交 PASS 与清理回执；完成前 AUTH-04 只能维持组件级结论 |
| H-05 | SEC-01 / Package TTL | 服务直接消费 DEC-003 冻结值并拒绝非 86400 配置；增加过期包条件清理、批量 sweeper 核心及每 5 分钟 EventBridge 调度资源 | 已关闭（本地实现） | AWS 部署阶段验证真实调度、数据库清理和撤证/重签链；异常恢复顺序仍按原报告 M-04/P1 跟踪 |
| H-06 | SEC-01 / Logging & Trace | 生产直接 `console.error` 接入统一 redacting logger；增加 Trace attributes 脱敏入口及生产源码 sink 静态门禁；审计/日志秘密值测试通过 | 已关闭 | 新增日志或 Trace SDK 时必须通过 `check:sensitive-sinks`，禁止直接写 sink |
| H-07 | SEC-01 / KMS IAM | 证书包 Key 区分管理面与数据面 KeyPolicy；数据面仅允许确定性 API Lambda Role；模板测试按通配语义检查加解密动作 | 已关闭（模板级） | AWS 部署阶段补 IAM Policy Simulator/真实 KMS 拒绝回执 |

本地关闭率为 **6/7（85.7%）**；另 1 项 H-04 为经明确授权的延期验收，不计作已关闭。

## 3. 验证证据

本次已执行并通过：

```text
TypeScript typecheck：19/19 tasks PASS
Vitest：88 files，748/748 PASS
Contracts：270/270 PASS
Build：13/13 tasks PASS
CDK synth：exit 0；H-01 的 3 条 F3031 为 0
Boundaries / Schemas / Migrations / ENG-DB-DOM evidence / Secrets：PASS
Sensitive log and Trace sinks：PASS
专项复验：3 files，42/42 PASS
```

环境说明：当前为 Node.js v24.12.0，而仓库声明 `>=20.19 <21`；因此通过固定 pnpm 10.20.0 执行等价底层命令。CDK 仍报告 6 条 Node.js 20 runtime warning，这是已登记的 M-01/P1 风险。

全仓 OpenAPI Gate 仍被本次修改前已存在的两个重复 `operationId` 阻塞：

- `listMedia`：`prototype-planned-api.json` 与 `admin-media-api.json` 重复；
- `createOtaCampaign`：`prototype-planned-api.json` 与 `admin-ota-campaign-api.json` 重复。

本次整改未修改上述 OpenAPI 文件，未将其混入 P0 提交范围。

## 4. AUTH-04 延期验收登记

### 4.1 延期原因和风险

- 原因：当前尚未进入 AWS 部署/集成阶段，没有隔离 AWS 测试账号和可用 AWS CLI 凭据。
- 剩余风险：本地 Policy builder 与模板测试不能证明目标 AWS 账号中证书、Thing/Thing Group 最终合并权限仍正确拒绝跨设备和错误方向操作。
- 当前授权：项目方同意先提交本地整改，AUTH-04 真实 AWS IoT 验收不阻塞当前开发进程。
- 边界：该授权只改变当前提交阻塞关系，不等于风险消失、云端验收通过或生产发布授权。

### 4.2 重新打开条件

满足下列任一条件时，AUTH-04 云端验收自动成为阻塞项：

1. 获得隔离 AWS 测试账号并开始 IoT 集成；
2. 部署首个包含 IoT Thing/证书/Policy 的开发环境；
3. 进入 QA-04、安全验收、预发布或生产发布 Gate。

### 4.3 后续执行命令和通过标准

```bash
FDP_AWS_IOT_INTEGRATION=1 \
AWS_REGION=ap-southeast-1 \
pnpm test:aws-iot-authz
```

默认回执路径：`docs/audit/evidence/auth-04-aws-iot-authorization.json`。

通过标准：

- 两台 Thing、两张证书、两份单设备 Policy 创建并附加成功；
- 两个 principal 的自身 Connect/上行 Publish/下行 Subscribe+Receive 全部 `ALLOWED`；
- 跨设备、发布下行、订阅/接收上行、通配 Topic/Filter 全部不为 `ALLOWED`；
- 回执中 probe 失败数为 0，资源清理失败数为 0；
- 回执不包含证书私钥或其他凭据材料，并随后续验收提交入库。

## 5. 当前 Gate 表述

| 范围 | 状态 |
|---|---|
| 本次 P0 本地整改提交 | **READY TO COMMIT** |
| AUTH-04 组件/本地 Policy 测试 | **PASS** |
| AUTH-04 真实 AWS IoT 验收 | **DEFERRED / NOT VERIFIED** |
| AWS 部署/生产验收 | **NOT ACCEPTED** |
