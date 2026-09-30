# GitHub 私人仓库到 AWS 测试环境的 OIDC 发布身份

更新日期：2026-09-30。仓库保持 `inrust/food-digester-platform` 私人账号仓库。GitHub Actions 使用 OIDC 临时凭据；本地开发继续使用 SSO。此文档只准备第 2 步的 IAM 身份，不代表发布已经启用或目标 AWS 验收通过。

## 已核对的定位信息

| 项目 | 值 |
|---|---|
| AWS 账号 / 区域 | `065986019555` / `ap-southeast-1` |
| 测试环境 CDK Stack | `AppDependencies`（CloudFormation 名 `fdp-test-app`） |
| GitHub 仓库 | `inrust/food-digester-platform`，owner ID `8358101`，repository ID `1346783527` |
| GitHub OIDC Provider | `https://token.actions.githubusercontent.com`，Audience `sts.amazonaws.com` |
| 拟创建角色 | `fdp-test-github-deploy-role` |
| 角色权限边界 | 拟创建 `arn:aws:iam::065986019555:policy/FDP-GitHubActionsTestBoundary` |

GitHub 官方文档规定，2026-07-15 后创建的仓库默认在 `sub` 中包含 owner/repository ID。信任文件 [FDP-GitHubActionsTestTrust.json](../infra/iam/FDP-GitHubActionsTestTrust.json) 只允许上述不可变仓库 ID 的 `main` push subject；没有通配符，也没有开放 PR 或其他分支。首次真实运行时仍须核对 GitHub 发出的 subject；若仓库曾使用自定义 OIDC subject，不应放宽信任条件来绕过失败。[GitHub OIDC subject 格式](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)

私人账号仓库可以运行 GitHub Actions，不需要迁移到组织。当前 GitHub Free 计划下，该私人仓库的分支保护规则不强制执行；若以后希望仍归私人账号但启用分支保护，GitHub Pro 是官方支持的选项。[私人仓库 Actions 额度](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、[分支保护可用计划](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

## 具备 IAM 管理权限的人员执行

当前 `esgiot-infra` SSO 身份对 `iam:ListOpenIDConnectProviders` 和精确 Provider 的 `iam:GetOpenIDConnectProvider` 均返回 `AccessDenied`，所以未能确认 Provider 是否存在；`fdp-test-github-deploy-role` 的精确 `GetRole` 返回 `NoSuchEntity`。不要在未核对 Provider 的情况下盲目创建。现有 `FDP-DeploymentBoundary` 没有允许 `sts:AssumeRole`，不适合直接挂到 GitHub 发布角色；管理员应为它创建下方专用边界。[FDP-GitHubOIDCSetupPermissions.json](../infra/iam/FDP-GitHubOIDCSetupPermissions.json) 给出执行下列命令所需的精确 IAM 权限，可由 IAM Identity Center 管理员合并到专用 Permission Set；仍需核对该身份的边界及组织 SCP。不要覆盖权限集已有策略。随后在本仓库根目录执行：

```bash
export AWS_PROFILE=<有权限的管理员Profile>
export AWS_REGION=ap-southeast-1

aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::065986019555:oidc-provider/token.actions.githubusercontent.com
```

若返回 `NoSuchEntity`，创建一次 Provider；若已存在，核对 URL 和 Client ID 包含 `sts.amazonaws.com`，不创建第二个。AWS CLI 允许省略 thumbprint，由 IAM 获取并校验公开 CA 链。[AWS OIDC Provider API](https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateOpenIDConnectProvider.html)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com

aws iam create-policy \
  --policy-name FDP-GitHubActionsTestBoundary \
  --policy-document file://infra/iam/FDP-GitHubActionsTestBoundary.json

aws iam create-role \
  --role-name fdp-test-github-deploy-role \
  --assume-role-policy-document file://infra/iam/FDP-GitHubActionsTestTrust.json \
  --permissions-boundary arn:aws:iam::065986019555:policy/FDP-GitHubActionsTestBoundary

aws iam put-role-policy \
  --role-name fdp-test-github-deploy-role \
  --policy-name FDP-GitHubActionsTestPermissions \
  --policy-document file://infra/iam/FDP-GitHubActionsTestPermissions.json
```

仅在 Provider 不存在时运行 `create-open-id-connect-provider`；仅在专用边界不存在时运行 `create-policy`，否则先核对默认策略版本是否与仓库文件一致。角色创建前再次确认 `GetRole` 返回 `NoSuchEntity`；若角色已由其他人创建，核对并审阅其 trust、边界和权限，不覆盖。权限文件及专用边界均只允许承担现有测试 CDK 的 deploy/file/image/lookup 四个角色，并读取该测试 Bootstrap 版本参数；不授予迁移 Runner、管理员初始化、DNS 修改或长期 Access Key 权限。现有 Bootstrap 角色的信任策略允许同账号主体承担，但须在首次发布中验证完整角色链。

验证命令：

```bash
aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::065986019555:oidc-provider/token.actions.githubusercontent.com \
  --query '{Url:Url,ClientIDList:ClientIDList}'
aws iam get-role --role-name fdp-test-github-deploy-role \
  --query 'Role.{Arn:Arn,Trust:AssumeRolePolicyDocument,Boundary:PermissionsBoundary}'
aws iam get-role-policy --role-name fdp-test-github-deploy-role \
  --policy-name FDP-GitHubActionsTestPermissions
```

角色验证通过后，在 GitHub 仓库 Variables 配置 `FDP_TEST_DEPLOY_ROLE_ARN=arn:aws:iam::065986019555:role/fdp-test-github-deploy-role`，再补齐证书和 truststore 定位参数。**不要立即把 `FDP_DEPLOY_ENABLED` 设为 `true`**：先完成 OIDC 首次运行、CDK diff 审阅和发布门禁。当前私人账号仓库的分支保护在现有 GitHub 计划下不生效，故启用自动部署后，任何有权直接推送 `main` 的人都能触发发布；这一访问边界须由仓库所有者明确接受或另行限制。
