# QA-09 唯一 Key 写入与 DLQ Worker 权限复核

结论：唯一 KMS Key 的真实策略写入及撤销 **PASS**，原 Key policy 全文恢复；DLQ 处置在 `iam:PutRolePolicy` 被拒绝前停止，消息删除0、剩余20可见/0在途。完整QA-09保持PARTIAL，不覆盖其他任务最新应用/浏览器验收结论。

## 授权和本次执行范围

运维已下发 FDP-InfraSetup：移除旧 `TemporaryQA09ManageExactProvisioningWorker`；唯一 Key 的 PutKeyPolicy 临时Allow截止 `2026-10-05T00:00:00Z`（北京时间2026-10-05 08:00），其他Key仍Deny；附加策略仅PowerUserAccess，未恢复IAMFullAccess。实际inline及附加策略快照均保存。

唯一Key：`arn:aws:kms:ap-southeast-1:065986019555:key/22af85c4-76d3-40c9-a849-0621740afe6c`。

仅追加 `Qa09CommandDlqDiagnosticDecrypt`：kms:Decrypt、唯一Command Worker、ViaSQS新加坡、唯一command-publish-dlq、同一固定期限。写前当前策略与备份全文一致；写后只多一条精确语句。无BypassPolicyLockoutSafetyCheck、无通用Key写入、无人类Decrypt、无Secret/CA写入、无CloudFormation执行或共享Lambda配置变更。

新的AWS内只读Build证明旧前缀qa09-c6b8375015168915的20个命令及COMMAND_PUBLISH_REQUESTED Outbox均为空，writes=0，20个精确ID与已闭环业务/设备ledger匹配。

准备一次性Worker时，AWS真实PutRolePolicy返回AccessDenied，理由为没有identity-based Allow。没有创建诊断函数或添加临时inline。finally从最新Key策略仅撤销自有Sid，核验原策略全文一致；Worker原inline全文一致。独立最终计数20可见/0在途。旧失败及本轮原始回执保留。

## 还缺的精确 IAM 前置

当前基础管理语句 `AllowCreateAndManageOnlyFDPProjectRolesWithBoundary` 绑定 `FDP-PermissionsBoundary`；指定Worker实际为 `FDP-ServiceBoundary`。现有带条件管理语句未使本次操作获准，不能用历史allowed模拟代替真实PutRolePolicy结果，也不能为通过操作改Worker边界。

请运维在 **FDP-InfraSetup Permission Set inline** 中追加下列临时语句并下发；不是写入Worker自身，也不是恢复IAMFullAccess：

```json
{
  "Sid": "TemporaryQA09ManageExactCommandPublisherInline",
  "Effect": "Allow",
  "Action": ["iam:PutRolePolicy", "iam:DeleteRolePolicy"],
  "Resource": "arn:aws:iam::065986019555:role/fdp-test-command-publisher-role",
  "Condition": {
    "DateLessThan": {"aws:CurrentTime": "2026-10-05T00:00:00Z"}
  }
}
```

这份语句只有指定角色的inline添加/撤销权限，不授予边界修改、信任策略修改或其他角色管理。角色与原策略在执行前后仍需精确核验。指定Worker拟加的唯一临时inline只允许唯一DLQ的GetQueueAttributes/ReceiveMessage/DeleteMessage/ChangeMessageVisibility，附同一到期条件；未知消息保留，不Purge/Redrive，正文或ReceiptHandle不输出。

## KMS 到期边界需要补强

实际 `DenyKMSPutKeyPolicyExceptTemporaryQAKey` 的NotResource例外没有时间条件，而PowerUserAccess v12的Allow/NotAction排除了IAM、Organizations、Account但包含KMS。因此临时Allow到期后，该Key仍可能经PowerUserAccess获准写入；单条Allow的期限不等于有效权限期限。[AWS PowerUserAccess策略定义](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/PowerUserAccess.html)

运维应追加显式到期Deny（或在任务结束后立即恢复原全Key PutKeyPolicy Deny）：

```json
{
  "Sid": "DenyExactQAKeyPutPolicyAfterTemporaryWindow",
  "Effect": "Deny",
  "Action": "kms:PutKeyPolicy",
  "Resource": "arn:aws:kms:ap-southeast-1:065986019555:key/22af85c4-76d3-40c9-a849-0621740afe6c",
  "Condition": {
    "DateGreaterThanEquals": {"aws:CurrentTime": "2026-10-05T00:00:00Z"}
  }
}
```

本轮未自行修改SSO Permission Set。自有Key补丁已经撤销；运营侧管理例外仍需运营恢复回执。下次完成后移除临时IAM Allow及KMS Allow/NotResource例外，恢复原Key写入Deny，并再次下发。不能仅删除Allow而保留无期限的NotResource例外。

## 测试、证据与下一步

- `PATH=/Users/anray/.nvm/versions/node/v24.12.0/bin:$PATH node --import tsx --test scripts/qa09-command-dlq-scope.test.mjs scripts/qa09-command-dlq-worker.test.mjs`：2/2 PASS。
- 精确Key受控执行器：Key追加/撤销PASS；总退出码1，Worker真实IAM拒绝，整体PARTIAL。
- 本次没有修改产品代码；仓库起点为061db01。旧受验应用b885e11证据保留，不声称该版本仍为当前应用。
- [证据目录](evidence/qa-09-dlq-exact-key-2026-10-04/)、[机器汇总](evidence/qa-09-dlq-exact-key-2026-10-04/summary.json)、[两条精确前置JSON](evidence/qa-09-dlq-exact-key-2026-10-04/operator-exact-followup-additions.json)。

下一可执行任务：运维落实上述指定Worker临时inline管理权限和有效KMS截止边界后，在有效期限内重新获取数据库闭环证明，再执行一次性Worker逐条处置；成功或失败均撤销自有函数/inline/Key Sid，并核验原策略与队列结果。原操作授权无需重复确认。
