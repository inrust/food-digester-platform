# 密码重置修复部署与真实流程复测（2026-10-14）

修复提交：`e8991d3f35342c5d8525f9278c4fd1cf1f98ed55`。CI 接入补充提交：`f5cb56666e1c010ab179421aab108da7973de089`。目标：AWS 账号 `065986019555`、`ap-southeast-1` 测试环境、`https://admin.bio-nexa.com` 与 `https://api.bio-nexa.com`。

## 历史失败与修复

| 检查 | 原提交结果 | 说明 |
| --- | --- | --- |
| [CI 38515868848](https://github.com/inrust/food-digester-platform/actions/runs/38515868848) | FAIL | `scripts/admin-e2e.test.mjs` 的独立 Playwright discovery 与严格清单不一致，错误 `BROWSER_DISCOVERY_MANIFEST_MISMATCH`；1406 项脚本测试中 1405 通过、1 失败 |
| [Deploy test API 38515868843](https://github.com/inrust/food-digester-platform/actions/runs/38515868843) | FAIL | 同一 `pnpm verify` 检查失败，未执行 AWS 身份配置/CDK 部署 |
| Amplify job 135 | SUCCEED | 网页独立部署完成，精确绑定 `e8991d3f`；北京时间 13:20:25 完成 |

原因是新增的两个密码重置浏览器用例未接入已有 QA05 严格清单和隔离回执 fixture。补充提交将它们登记为必需用例，接入每次执行的独立前缀、网络 guard、清理回执和 `passwordResetLogin` / `canonicalUsername` 行为证明。总数由 36 更新为 38，串行与并行重复合计由 108 更新为 114。缺失用例、额外用例、缺失行为证明、重复前缀等失败关闭规则保持有效；源码哈希还纳入新增用例依赖的独立 Cognito 服务端模拟与 helper。

补充提交与原修复提交的 `apps/admin-web/src` Git tree 均为 `ad3663365e166371a617074146b69cefa7468602`，`apps/cloud-api/src` tree 均为 `ad70284f301deccd724778ad42e695c7182b17cd`；运行时代码完全一致。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| `node --test scripts/admin-e2e.test.mjs` | PASS，48/48；含独立 Playwright discovery 及新增两项行为证明缺失负探测 |
| `node scripts/run-admin-e2e.mjs /private/tmp/fdp-reset-followup-browser-receipt.json` | PASS，38 项串行 + 76 项并行重复，114 次独立执行，清理通过 |
| 变更文件 ESLint、E2E TypeScript、Prettier、Git diff、secrets 与 sensitive-sinks | PASS |
| 工作目录直接执行 `pnpm verify` | FAIL：既有未跟踪 `build/` 临时脚本被 ESLint 扫描，52 项错误；未修改或删除这些既有文件。本地浏览器全量通过不替代远程完整验证 |

浏览器回执：[admin-password-reset-browser-2026-10-14.json](evidence/admin-password-reset-browser-2026-10-14.json)。该回执明确为本地模拟 API，与真实目标回执分开。

## 最新部署

- Amplify job 136：`SUCCEED`，绑定 `f5cb5666`，北京时间 13:57:57 完成；job 135 的原始成功记录保留。
- [CI 38519233755](https://github.com/inrust/food-digester-platform/actions/runs/38519233755)：`completed / success`，精确绑定 `f5cb5666`，完整 `pnpm verify` 通过。[回执](evidence/admin-password-reset-ci-workflow-2026-10-14.json)
- [Deploy test API 38519233568](https://github.com/inrust/food-digester-platform/actions/runs/38519233568)：`completed / success`，精确绑定 `f5cb5666`；完整验证、AWS 账号与 SHA 校验、CDK diff/deploy 全部通过。[回执](evidence/admin-password-reset-deploy-workflow-2026-10-14.json)
- [Amplify job 136 回执](evidence/admin-password-reset-amplify-2026-10-14.json)不含构建日志下载签名或工件签名 URL。

## 真实用户流程

用户提供测试邮箱 `inrust@126.com` 并明确授权完整验证：创建后删除临时管理员测试身份，通过真实后台重置该账号并发送邮件，使用用户提供的验证码设置随机测试新密码，再验证登录。未操作其他现有账号。

当前真实执行结果：

- 既有测试邮箱在 Cognito 唯一存在、启用且为 `CONFIRMED`。
- 隔离管理员身份使用 `SUPPRESS` 创建，不发送邀请邮件；真实 Chromium 使用邮箱别名登录线上网页并进入用户管理页面。
- 线上重置确认对话框明确说明验证码不是登录密码；真实 `POST /api/v1/admin/users/d72ac78f-88a7-466c-a423-5b353f90bfc6/password-reset` 返回 200，API Gateway requestId `dbaa70b6-bbea-425b-81a8-386cf4a29401`。
- Cognito 状态读回 `RESET_REQUIRED`。临时管理员身份已删除，`AdminGetUser` 确认 `UserNotFoundException`。
- 线上“已有重置验证码”入口及确认页已验证；用户提供收到的邮件验证码后，真实 `ConfirmForgotPassword` 返回 200，requestId `e0e643ae-2996-4857-8e53-f1cb5e37f9f5`。
- 确认新密码后尚未建立浏览器登录会话；将邮件验证码当作登录密码返回认证拒绝，页面提示用户名或密码错误。
- 使用设置的新密码通过真实邮箱别名 SRP 登录，进入 Dashboard，登录后的 Dashboard API 返回 200；浏览器 ID Token 的主体与指定账号的真实 Cognito sub 一致。
- Cognito 读回 `CONFIRMED` 且仍启用。两个阶段的测试浏览器进程均已结束；临时管理员身份删除及浏览器 context 清理均通过。
- 未获得该账号原密码，因此未对真实原密码执行负探测；原密码失效按 Cognito `AdminResetUserPassword` 语义成立，本地独立 SRP 服务端回归另验证了新旧密码行为。

真实目标回执：[admin-password-reset-live-2026-10-14.json](evidence/admin-password-reset-live-2026-10-14.json)：`PASS_REAL_EMAIL_ADMIN_RESET_AND_BROWSER_LOGIN`，25 项断言全部通过。不保存验证码、密码、Token 或 AWS 凭证。用户提供的账号新密码由验证进程在内存中生成，单独交付用户，不进入回执或仓库。准备阶段加载原修复网页，确认阶段加载补充提交网页，两者运行时源码树完全一致。

API 部署完成后，另用同一新密码在独立 Chromium context 中重新登录线上网页。结果 `postDeploymentLogin.result=PASS`：进入 Dashboard，真实 Dashboard API 返回 200，API Gateway requestId 已保存；ID Token 主体仍绑定指定账号，context 清理通过。此复测没有再次触发密码重置或重发邮件。

## 最终结论与边界

`f5cb5666` 的完整 CI、测试 API 部署、Amplify 网页部署和真实邮件重置后登录均通过，密码重置修复已在测试环境上线。原 `e8991d3f` 的 CI/部署失败保持 FAIL，不能追溯改写成成功；后续补充修复提供新的成功回执。

本报告及回执归档属于文档变更；归档提交与 `f5cb5666` 的运行时代码一致。这里确认的是密码重置修复的部署与实测，不扩展为整个 QA-09 的正式验收结论。
