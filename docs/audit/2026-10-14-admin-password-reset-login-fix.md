# 管理员重置密码后登录失败修复（2026-10-14）

基线：`f0396ee76498954d2b800e72771778508cbb0fe6`。用户截图显示将邮件通知中的内容作为密码登录后，页面提示用户名或密码错误。截图未包含邮件正文及 Cognito 原始响应，因此不能据此确定该账号当时的实际状态；本次按源码检查并复现可导致此问题的两条链路。

## 原因与修复

1. **重置验证码被描述成临时凭证。** 管理员重置调用 `packages/aws-clients/src/cognito-admin.ts` 的 `AdminResetUserPassword`。该接口使旧密码失效、进入 `RESET_REQUIRED` 并发送重置验证码；与邀请邮件中的临时密码不同，验证码须通过 `ConfirmForgotPassword` 设置新密码，不能直接登录。管理页确认和成功提示、类型注释、REST 契约及当前开发说明原先混淆了两种语义，现已同步修正。[AWS 接口说明](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminResetUserPassword.html)
2. **邮箱别名被用于 SRP challenge 应答。** `AuthFlow.login()` 用 `USER_ID_FOR_SRP` 计算签名，却用用户输入的邮箱提交 `PASSWORD_VERIFIER`，并把邮箱沿用到首次改密/MFA challenge。内部用户名与邮箱不同的账号可因此返回 `NotAuthorizedException`。现将 Cognito 返回的 `USER_ID_FOR_SRP` 用于签名、应答及后续 challenge。原代码在新增的独立 SRP 服务端模拟中，改密和 MFA 两个场景均复现 `INVALID_CREDENTIALS`；修复后通过。[AWS SRP 用户名要求](https://docs.aws.amazon.com/sdk-for-swift/latest/api/awscognitoidentityprovider/documentation/awscognitoidentityprovider/admininitiateauthoutput/challengeparameters/)

登录页增加中英文“已有重置验证码”入口，直接使用管理员已发送的验证码，不调用 `ForgotPassword` 重发。登录遇到 `PasswordResetRequiredException` 时自动转入同一确认页。确认页说明验证码的用途，成功后清除新密码与验证码并返回登录；验证码错误/过期时展示对应提示，并提供重新获取入口。切换步骤清除凭证字段，提交期间禁止切换步骤。后端继续由 Cognito 直接发送验证码，管理员 API 无密码或验证码输入/输出。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run apps/admin-web/test packages/aws-clients/test/cognito-admin.test.ts apps/cloud-api/test/admin-user.test.ts` | PASS，38 文件 / 393 测试 |
| `node --import tsx --test contracts/rest/admin-user-api.test.ts` | PASS，3 测试 |
| admin-web 主程序及 E2E TypeScript、变更 TS/TSX ESLint、Prettier | PASS |
| `node scripts/build-openapi.mjs --check` | PASS，bundle 已同步 |
| `node scripts/check-secrets.mjs` / `node scripts/check-sensitive-sinks.mjs` | PASS |
| `pnpm --filter @fdp/admin-web exec playwright test password-reset.spec.ts` | PASS，真实 Chromium 2/2，375px 与 1440px；生产构建通过 |

浏览器回归使用模拟 Cognito 与独立 SRP 服务端复算，覆盖：将验证码作为登录密码 → 自动进入重置页 → 已有验证码确认新密码（不重发）→ 未提前建立会话 → 旧密码拒绝 → 新密码通过邮箱别名 SRP 登录 → Dashboard；确认页无横向溢出。组件测试另覆盖中英文已有验证码入口、错误/过期验证码及重新获取；认证编排测试覆盖内部用户名的首次改密/MFA 续接、刷新与新旧密码验证。

## 交付边界与复测步骤

本地修复与回归通过；本报告不表示已部署或真实 Cognito/邮件目标验收通过。未操作截图中的用户账号，也未重置真实用户密码。正常构建仍有既存的 bundle 大于 500 kB 提示。

发布后由管理员触发一次密码重置。用户收到邮件后，在登录页点击“已有重置验证码”，输入邮箱、邮件验证码及自行设置的新密码；看到重置成功提示后使用新密码登录。邮件验证码若过期，点击“重新获取验证码”申请新验证码。邀请邮件中的临时密码仍走首次登录改密流程。
