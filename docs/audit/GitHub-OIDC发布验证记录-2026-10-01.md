# GitHub OIDC 发布验证记录（2026-10-01）

## 历史记录：3d27684 验证与修复

- 仓库：`inrust/food-digester-platform`。
- 分支：`main`。
- 已推送源提交：`3d27684160c4ce87d723f331e1057d2707517ba6`。
- `FDP_DEPLOY_ENABLED=true` 和五个部署参数已通过 GitHub Variables 页面核实。
- SSO：`esgiot-infra` / `FDP-InfraSetup`，账号 `065986019555`。
- **测试发布尚未完成**。两次重试均被验证门禁阻止，OIDC 登录、CDK diff/deploy 未执行。

## GitHub 执行证据

| 执行 | 结果 | 证据 |
| --- | --- | --- |
| CI run `36800194560` | SUCCESS，153 个测试文件 / 1274 个 Vitest 测试通过，完整 verify 成功 | [CI](https://github.com/inrust/food-digester-platform/actions/runs/36800194560) |
| Deploy run `36800194497` attempt 1 | SKIPPED；启用变量后由 Codex 重跑 | [Deploy](https://github.com/inrust/food-digester-platform/actions/runs/36800194497) |
| Deploy attempt 2 / job `110175105754` | FAILED；1273 通过，1 个 CDK synth 测试超过 15 秒 | [首次重跑](https://github.com/inrust/food-digester-platform/actions/runs/36800194497/job/110175105754) |
| Deploy attempt 3 / job `110178277293` | FAILED；1274 个 Vitest 测试通过，浏览器测试 14 通过 / 1 失败 | [第二次重跑](https://github.com/inrust/food-digester-platform/actions/runs/36800194497/job/110178277293) |

首次失败位置：`infra/test/app-stack.test.ts:514`，测试“仅显式 local/test 模式可保留无 mTLS 的默认入口”，报 `Test timed out in 15000ms`。同一提交在 CI 及第二次部署重跑均通过该测试，表明运行耗时波动。

第二次失败位置：`apps/admin-web/e2e/admin-web.spec.ts:1536`，FE-19 遍历测试，报 `Protocol error (Runtime.callFunctionOn): Internal server error, session closed`。日志不足以确认是浏览器崩溃还是测试结束清理导致会话关闭，不能将其判定为页面出现了未交付提示。

## 修复范围

1. FE-19 原本在一个测试、同一个页面中进行 22 路由 × 2 语言 × 3 视口的 132 次导航。拆成六个语言/视口测试，各使用独立页面和测试限时，再独立验证语言刷新保持。全部 132 个组合、布局裁切检查、组合根检查和语言断言均保留。
2. 仅把实际出现超时的 CDK synth 测试限时从 15 秒调整为 60 秒；所有资源与认证断言保留。

这些调整针对已观察到的验证运行耗时及会话问题，仍需新提交的 GitHub 运行确认稳定性。本次未修改应用代码、工作流门禁或 AWS IAM 权限。

## 修复后的本地验证

- 完整 `pnpm check:admin-web-e2e`：**21/21 通过**，包括 FE-19 六组全部 132 个组合及语言刷新保持。
- 定向 Vitest：mTLS 测试 **1 通过、38 跳过**；跳过项来自定向过滤，不是删除测试。
- 两个修改文件 ESLint、Prettier 和 `git diff --check` 通过。
- 本地结果不能替代新提交的 GitHub 验证及实际发布。

## AWS 状态回读

两次部署重跑结束后，`fdp-test-app` 仍为 `UPDATE_COMPLETE`，`LastUpdatedTime=2026-09-24T01:35:45.520000Z`，与发布前一致。本次没有进入 AWS 发布步骤。

发布前记录的三个 Lambda 均为 `nodejs24.x`、`Active`、`LastUpdateStatus=Successful`：

| Lambda | 发布前 LastModified | 发布前 CodeSha256 |
| --- | --- | --- |
| `fdp-test-api` | `2026-09-24T01:35:53.000+0000` | `oOJSq6hTejqsCXcvuVe6cAthJNkjPf/abUiAPbYPWfk=` |
| `fdp-test-device-api-handler` | `2026-09-22T07:18:59.000+0000` | `lotv92mwiRtMYOgqM7MTV9QlltQbZ+nTOF6P+JUb64o=` |
| `fdp-test-onboarding-api-handler` | `2026-09-22T07:18:59.000+0000` | `vSrM5VvXUBbsYaPPPWUnfzgyNTzIBY7DjdjUPMDFRTs=` |

三个 API Gateway 自定义域名均为 `AVAILABLE`。Device 域名保留 mTLS truststore 及版本；三个域名均为根路径映射至 `test` Stage。

## 下一步与验收边界

仓库 AGENTS.md 要求全部远程推送由人工通过 GitHub Desktop 执行。必须先推送本次本地修复提交，才能对其运行 GitHub 验证。

推送后，`main` push 将自动触发已启用的发布工作流。验收应确认：完整 verify 成功、OIDC AssumeRoleWithWebIdentity 成功、目标账号和提交校验成功、CDK 发布成功、CloudFormation 更新完成、三个 Lambda 代码及状态回读一致，再执行不带凭据的入口拒绝探测。

当前 OIDC 实际登录与 Lambda 新代码发布仍为 **NOT RUN / NO RECEIPT**。此次失败发生在验证阶段，没有证据表明需要扩大 IAM 权限。


## 3ba768c 实际发布与恢复（本轮）

- 已推送并实际执行的源提交：`3ba768cf5523e4eb0a96fca04403bdbeffd14fc9`。
- [CI run 36803467863](https://github.com/inrust/food-digester-platform/actions/runs/36803467863)：完整 verify 成功，153 个 Vitest 测试文件 / 1274 个测试通过。
- [Deploy run 36803467774 attempt 1](https://github.com/inrust/food-digester-platform/actions/runs/36803467774/job/110182672823)：完整 verify、OIDC 登录、账号与提交校验、CDK diff 均成功；CloudFormation 更新失败。
- OIDC 实际日志：`Authenticated as assumedRoleId AROAQ6XISYDRWVV2XWJZA:fdp-test-36803467774`。GitHub 角色没有使用 SSO 权限或长期 AWS Access Key。

### 失败原因与最小修复

CloudFormation 执行角色 `fdp-test-cloudformation-execution-role` 缺少 `iam:UpdateRoleDescription`。更新 `fdp-test-onboarding-api-role` 的描述被拒绝，后续回滚也被同一权限阻止，Stack 进入 `UPDATE_ROLLBACK_FAILED`。

修复前，AWS 托管策略 v7 与仓库 JSON 内容一致。以下两份策略增加同一个语句，并发布为默认版本 v8：

- `FDP-CloudFormationExecutionPolicy`（权限授予）。
- `FDP-DeploymentBoundary`（权限上限）。

```json
{
  "Sid": "UpdateOnboardingRoleDescription",
  "Effect": "Allow",
  "Action": "iam:UpdateRoleDescription",
  "Resource": "arn:aws:iam::065986019555:role/fdp-test-onboarding-api-role"
}
```

IAM 模拟结果为 `allowed`，`AllowedByPermissionsBoundary=true`。GitHub 发布角色自身的 trust、inline policy 和 `FDP-GitHubActionsTestBoundary` 未变更。

执行 `continue-update-rollback`，未传入 `resources-to-skip`。2026-10-01 02:18:57 UTC，Stack 已恢复为 `UPDATE_ROLLBACK_COMPLETE`；onboarding IAM Role 与 Cognito User Pool 均回滚完成。

已启动同一源提交的 [attempt 2 / job 110188169687](https://github.com/inrust/food-digester-platform/actions/runs/36803467774/job/110188169687)，最终结果为 **SUCCESS**，任务耗时 17 分 11 秒。


### 发布后的 AWS 验证

- Stack `fdp-test-app`：**UPDATE_COMPLETE**，本次更新启动时间 `2026-10-01T02:35:01.064000Z`。
- 三个 Lambda 均为 `nodejs24.x`、`Active`、`LastUpdateStatus=Successful`，代码哈希相较发布前全部变化。

| Lambda | LastModified（UTC） | CodeSha256 |
| --- | --- | --- |
| `fdp-test-api` | `2026-10-01T02:35:59.000+0000` | `kS63DoW49OvRi7fRB3XvenWJOncJkLXnkryMHuVj4oQ=` |
| `fdp-test-device-api-handler` | `2026-10-01T02:35:55.000+0000` | `xI5PYwS/Vx66ffDcCLsMC6kwQ9xp852jyZi+MLWTrC8=` |
| `fdp-test-onboarding-api-handler` | `2026-10-01T02:35:56.000+0000` | `iA821VHGpRRbX3WWdE+oytZJ9aSvoYIsf9TYGNDZb+w=` |

已部署 CloudFormation 模板的三个 Lambda S3Key 与本次 GitHub CDK diff 一致：

- ApiFn：`2f0035fec9715f7c5c33ef5297c6c3243d085dd12db6dab745499862d3674dd1.zip`。
- DeviceApiFn：`b47ed73d258a1d8f64bf4e7e448f8dd7ffaf95fd0c17ba754e8a69dd66f59c56.zip`。
- OnboardingApiFn：`3fa18f3f77606809a6018a807d4cc633dcf0f2caea936360bb481acf887b442d.zip`。

补充 ZIP 下载校验因 S3 下载停滞已终止，未获得额外 ZIP 校验回执；代码一致性证据为已部署模板资产键、Lambda CodeSha256 和同一提交的成功工作流。

三个自定义域名均为 `AVAILABLE`；device 域名的 mTLS truststore URI 和版本保持一致。

无凭据入口探测：

| 入口 | 结果 | 验证范围 |
| --- | --- | --- |
| `api.bio-nexa.com/api/v1/admin/devices` | HTTP 401 | 未登录请求被拒绝 |
| `onboard-api.bio-nexa.com/api/v1/device/onboarding/status` | HTTP 400 / VALIDATION_FAILED | 新代码校验缺失 requestId；发布前旧代码为 401 |
| `device-api.bio-nexa.com/api/v1/device/config` | curl 56 / HTTP 000 / connection reset | 无客户端证书连接被拒绝；不是已认证设备业务验收 |

本次完成的是测试环境自动构建与发布链路验证。没有执行真实设备注册、管理员登录或数据库业务验收，不能据此宣称全部业务验收完成。

### 临时 IAM 权限撤回确认

- GitHub OIDC Provider ARN：`arn:aws:iam::065986019555:oidc-provider/token.actions.githubusercontent.com`。
- GitHub 角色 ARN：`arn:aws:iam::065986019555:role/fdp-test-github-deploy-role`。
- Permissions boundary：`arn:aws:iam::065986019555:policy/FDP-GitHubActionsTestBoundary`，默认版本 v1。完整内容见 `infra/iam/FDP-GitHubActionsTestBoundary.json`。
- Trust：完整内容见 `infra/iam/FDP-GitHubActionsTestTrust.json`，仅允许该仓库 main 的不可变 subject 与 `aud=sts.amazonaws.com`。
- Inline policy：仅 `FDP-GitHubActionsTestPermissions`，完整内容见 `infra/iam/FDP-GitHubActionsTestPermissions.json`；与 GitHub boundary 内容一致。
- Attached managed policies：**无**。Permissions boundary 是权限上限，不是 attached managed grant。
- 本轮新增修复：CloudFormation 执行权限与既有部署边界均为 v8，仅增加指定 onboarding 角色的 `iam:UpdateRoleDescription`。
- **测试发布已完成，可由人工撤回 FDP-InfraSetup 的临时 IAMFullAccess。** 不要删除 GitHub 发布角色、OIDC Provider 或部署所需策略。

可复核的 AWS 回读、恢复事件及成功截图保存在 `docs/audit/evidence/github-oidc-2026-10-01/`。远程推送仍由人工通过 GitHub Desktop 执行。
