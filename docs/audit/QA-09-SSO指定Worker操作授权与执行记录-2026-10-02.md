# QA-09 SSO 指定 Worker 操作授权与执行记录

用户已授权由 SSO 执行所需的指定 Worker 操作调整。本轮准备并尝试在唯一 FDP-InfraSetup Permission Set 追加临时语句，写入成功，但向测试账号 provision 失败。AWS 拒绝调用者对自身 AWSReservedSSO_FDP-InfraSetup 角色执行 iam:ListAttachedRolePolicies。新授权未生效；已回读保护后撤回本轮 Permission Set 增量，原配置及实际SSO角色策略一致，无CA补丁或新设备测试。下发请求 `2ced98f7-6147-40db-ae0b-684f28b7487a`，授权诊断ID `1dth0xts0i4iingg1jlt1cbg5`。

## 最终可应用授权

只追加以下 Statement，保留原语句。GetRole用于现有角色核验；PutRolePolicy用于添加原批准CA策略；DeleteRolePolicy用于结束后撤销。GetRolePolicy由现有esgiot-readonly承担。Worker的ServiceBoundary、CA密钥/Secret范围及到期时间不变；不包含管理SSO自身角色的权限。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TemporaryQA09ManageExactProvisioningWorker",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy"
      ],
      "Resource": "arn:aws:iam::065986019555:role/fdp-test-onboarding-provisioning-role",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::065986019555:policy/FDP-ServiceBoundary"
        },
        "DateLessThan": {
          "aws:CurrentTime": "2026-10-03T00:00:00Z"
        }
      }
    }
  ]
}
```

独立补丁：[addition JSON](evidence/qa-09-sso-worker-management-addition-2026-10-02.json)。该Document用于提取Statement后合并，不可直接覆盖完整Permission Set策略。原策略快照及候选合并文件已保存在evidence；使用前必须重新读取当前策略，保留其他人修改，不能盲目使用历史快照覆盖。

IAM PutRolePolicy按目标角色授权，不能通过此语句限制写入策略文档只能包含kms:Decrypt；执行程序仍必须仅提交原批准CA JSON，并且不得改该Worker的其他内联策略。

## 管理身份完成下发

本机仅有esgiot-dev、esgiot-infra、esgiot-readonly三个profile，没有已确认可完成下发的管理身份。用户授权已经明确，缺少AWS实际执行能力。运营人员无需直接实施CA补丁，但需要由Identity Center管理身份合并上述语句并完成账号下发，或提供可供本机执行的已授权profile引用，不传递密钥。

- Instance：`arn:aws:sso:::instance/ssoins-8210c299cb5e2bab`
- Permission Set：`arn:aws:sso:::permissionSet/ssoins-8210c299cb5e2bab/ps-821031d6e3ea1c86`（FDP-InfraSetup）
- 仅下发至测试账号：`065986019555`
- 原到期时间：UTC `2026-10-03T00:00:00Z`，北京时间08:00，不自动延长。

Identity Center控制台可在FDP-InfraSetup内联策略保留既有语句并添加上述Statement，再对该账号重新应用Permission Set。CLI流程为：读取最新inline policy、只追加指定Sid、PutInlinePolicyToPermissionSet、ProvisionPermissionSet（AWS_ACCOUNT，仅账号065986019555）、等待SUCCEEDED、回读实际SSO角色策略。管理身份必须本身具备完成下发所需能力；仅给当前SSO新增sso:ProvisionPermissionSet并不能解决本次失败，因为该API已经接受请求，异步下发过程缺IAM读取权限。若再遇其他下发缺口应按实际错误诊断，不授予iam:*或直接修改AWSReservedSSO角色。

实际下发生效后核验真实GetRole与带入ServiceBoundary/当前时间的模拟，必要时刷新SSO会话，然后添加原批准CA策略、回读并模拟CA解密，再核对应用版本、以新前缀进行真实验收。当前bcc8407的CI及部署均已成功，但新验收仍需完整工件/前端版本核验，不以CI成功替代业务验收。

结束顺序：清理本轮夹具 → SSO删除Worker临时CA策略并核验不存在 → 管理身份从最新Permission Set移除仅本轮Sid并重新下发 → 回读及模拟确认临时Worker操作增量已撤销。到期不等同于配置已删除。

## 验证和Gate

最终三项操作补丁的三组模拟共9/9断言PASS：精确Worker allowed，另一个ServiceBoundary角色及到期后均implicitDeny，无missingContext。这仅证明候选新增语句，不能替代实际权限下发。首次尝试还含GetRolePolicy，实际下发失败后已完全恢复；最终候选去掉该不必要操作，没有再次写入远端。

[应用与恢复回执](evidence/qa-09-sso-worker-management-application-2026-10-02.json)、[候选模拟回执](evidence/qa-09-sso-worker-management-simulation-2026-10-02.json)。本轮没有源码更改；格式、敏感信息及差异检查通过。QA-09仍PARTIAL / BLOCKED，下一步是可用管理身份落实指定Permission Set授权，不申请扩大Worker权限或更改ServiceBoundary。
