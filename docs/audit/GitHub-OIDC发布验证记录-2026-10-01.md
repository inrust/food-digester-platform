# GitHub OIDC 发布验证记录（2026-10-01）

## 验证对象与当前状态

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
