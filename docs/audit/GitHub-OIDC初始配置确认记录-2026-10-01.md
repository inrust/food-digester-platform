# GitHub OIDC 初始配置确认记录（2026-10-01）

## 当前结果

AWS IAM 初始配置已创建并回读验证。GitHub 真实 OIDC 登录及测试 Stack 发布尚未完成，状态为 NOT RUN / NO RECEIPT。

使用 SSO profile esgiot-infra，permission set FDP-InfraSetup，账号 065986019555，区域 ap-southeast-1。临时 IAMFullAccess 用于本次 IAM 初始化，未绑定给 GitHub 角色。

## GitHub OIDC Provider

ARN：arn:aws:iam::065986019555:oidc-provider/token.actions.githubusercontent.com

URL：https://token.actions.githubusercontent.com

ClientIDList：sts.amazonaws.com

Provider 和专用 boundary、role 在创建前 Get 均返回 NoSuchEntity；创建后分别成功回读。

## 专用权限边界

名称：FDP-GitHubActionsTestBoundary

ARN：arn:aws:iam::065986019555:policy/FDP-GitHubActionsTestBoundary

默认版本：v1。以下 JSON 与 AWS GetPolicyVersion 回读内容一致：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeOnlyTestCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ],
      "Resource": [
        "arn:aws:iam::065986019555:role/fdp-test-cdk-deploy-role",
        "arn:aws:iam::065986019555:role/fdp-test-cdk-file-publishing-role",
        "arn:aws:iam::065986019555:role/fdp-test-cdk-image-publishing-role",
        "arn:aws:iam::065986019555:role/fdp-test-cdk-lookup-role"
      ]
    },
    {
      "Sid": "ReadOnlyTestCdkBootstrapVersion",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters"
      ],
      "Resource": "arn:aws:ssm:ap-southeast-1:065986019555:parameter/cdk-bootstrap/fdptest01/version"
    }
  ]
}
```

## 发布角色 trust policy

角色 ARN：arn:aws:iam::065986019555:role/fdp-test-github-deploy-role

以下 JSON 与 AWS GetRole 回读内容一致：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyFoodDigesterMain",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::065986019555:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:inrust@8358101/food-digester-platform@1346783527:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

GitHub 的新仓库默认 subject 使用 owner ID 和 repository ID。参见 [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)。本仓库 subject 仍需真实 GitHub token 登录验证；未使用通配符放宽信任。

## 发布角色绑定策略

- Permissions boundary：FDP-GitHubActionsTestBoundary。
- Inline policy：FDP-GitHubActionsTestPermissions，仅此一个。
- Attached managed permission policies：空列表。
- IAMFullAccess / PowerUserAccess：均未绑定给 GitHub 发布角色。

Inline policy 通过 GetRolePolicy 回读，与上面的 boundary JSON 完全一致。

边界是权限上限，inline policy 是权限授予。GitHub 角色随后切换到四个测试 CDK bootstrap 角色执行发布。四个既有角色的 trust 均允许本账号 principal 切换，并保留原 FDP-DeploymentBoundary。

IAM SimulatePrincipalPolicy 验证指定 CDK 角色 AssumeRole/TagSession allowed；对 other-role 的 AssumeRole implicitDeny、AllowedByPermissionsBoundary=false。这是策略模拟，不代表真实 OIDC 或角色链调用成功。

## GitHub Variables

已在仓库 Settings → Secrets and variables → Actions → Variables 保存并通过页面回读五个参数：

| 名称 | 值 |
| --- | --- |
| FDP_TEST_DEPLOY_ROLE_ARN | arn:aws:iam::065986019555:role/fdp-test-github-deploy-role |
| FDP_DEVICE_API_CERTIFICATE_ARN | arn:aws:acm:ap-southeast-1:065986019555:certificate/db3daf4f-de27-4cb3-8813-5f1f068478e0 |
| FDP_PUBLIC_API_CERTIFICATE_ARN | arn:aws:acm:ap-southeast-1:065986019555:certificate/2777e55f-df6e-4e7d-8ce8-22cd3cf2babb |
| FDP_TRUSTSTORE_BUCKET_NAME | fdp-test-mtls-truststore-065986019555 |
| FDP_TRUSTSTORE_VERSION | FtN.3H5AydTqt6cgxf0wzeOcNQHFxCOx |

FDP_DEPLOY_ENABLED 尚未设置，部署任务继续跳过。参数来自 AWS API Gateway 三个现有域名的只读回读；未读取私钥、Secrets Manager 密钥或业务数据。

## 已发现并修复的 CI 阻塞

[CI run 36716570460](https://github.com/inrust/food-digester-platform/actions/runs/36716570460) 在迁移检查失败：脚本写死 packages/database/node_modules/.bin/prisma，但 .npmrc 使用 node-linker=hoisted。

修复 packages/database/scripts/check-migration-drift.mjs：由 Node 的包解析找到 prisma/build/index.js，再用当前 Node 执行。迁移结构检查、该文件 ESLint 与 Prettier 均通过。

本机 PATH 的 ~/.local/bin/pnpm 为另一版本，自动版本切换时无输出；使用 ~/.nvm/versions/node/v24.12.0/bin 中的 pnpm 10.20.0 完成验证。

## CDK diff 和发布范围

使用 SSO 执行 node scripts/esgiot-cdk.mjs diff AppDependencies 成功，目标为 fdp-test-app。

差异包括 19 个 Lambda 代码包、OnboardingApiFnServiceRole 描述，以及 Cognito 测试密码策略（最小长度 12→8，取消大写和符号必需项）。该密码策略来自既有提交 9e7cc6d，有对应测试，本次未修改。

当前 monorepo 将三个 API 和其他 Lambda 放在同一个 AppDependencies Stack，发布会更新该 Stack 所有源码差异。

CloudFormation 回读：fdp-test-app 为 UPDATE_COMPLETE，LastUpdatedTime 2026-09-24T01:35:45.520000Z；本次未执行 CloudFormation deploy。

## 后续人工操作与测试闭环

### 本地验证结果

- `pnpm verify`：lint、格式、typecheck、OpenAPI、测试、构建，以及浏览器测试之前的所有门禁通过；Vitest 153 文件、1274 测试通过。首次浏览器测试因沙箱监听端口 EPERM 中止，因此该次完整命令退出码为 1。
- 在允许监听的环境补跑 `pnpm check:admin-web-e2e`：15/15 通过。
- 补跑验证链剩余的 `pnpm check:cmd-ota-delivery`：runtime 与 CDK Gate 均通过。
- 上述为本地分段验证结果，GitHub 上的新提交 CI 与 OIDC 发布仍待运行。

1. 通过 GitHub Desktop 推送本次本地修复提交到 main；仓库规则禁止 Codex 推送。
2. 确认接受当前测试 Stack diff 后，在 GitHub Variables 新增 FDP_DEPLOY_ENABLED=true。设置该开关会使之后 main push 自动发布整个测试 Stack。
3. 在开关启用后推送提交，或在 Actions 对该次 push 产生的 Deploy test API 任务选择 Re-run all jobs。工作流仍只监听 main push，没有 workflow_dispatch。
4. 核验 configure-aws-credentials 的 OIDC 登录、CDK diff/deploy、CloudFormation 最终状态和三个 Lambda 的更新时间，并将结果绑定到该次完整提交 SHA。

撤回 FDP-InfraSetup 的临时 IAMFullAccess 不影响已创建的 GitHub 角色和角色链；只有需要进一步调整 IAM 配置时才需要管理员权限。此记录不把 AWS 初始化或策略模拟当成已完成测试发布。
