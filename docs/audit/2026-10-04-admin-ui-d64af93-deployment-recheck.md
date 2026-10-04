# d64af93 部署版本核验：前端通过，后端修复未部署

被测提交：`d64af93c30c071b84fba43cebeb91a43e9db865d`。现有环境：AWS `065986019555` / `ap-southeast-1` / `fdp-test-app`，环境标签为 test。本轮状态 **BLOCKED_BACKEND_FIX_NOT_DEPLOYED**；不能关闭 H-01/M-01 的真实目标复验。

| 核验项 | 当前结果 | 证据 |
| --- | --- | --- |
| 前端部署 | PASS | Amplify `d29sdr89i4zl0` main job 52，commitId 与被测完整 SHA 一致，SUCCEED；北京时间 12:57:02 启动、12:59:46 完成 |
| API Lambda | 修复未部署 | `fdp-test-api` Active / Successful，但 LastModified 为 `2026-10-03T14:28:44Z`；CodeSha256 仍为 `fkxEuQu+sAsqGDBFycHFVUOPnFaDTj43p/1qvEZ3u14=` |
| 修复前制品对照 | MATCH | 当前 API 哈希等于 b885e11 历史 PASS 回执中已核验 ZIP 的哈希；H-01 服务源码在 d64af93 已变更，不能把旧制品视为已包含修复 |
| CloudFormation | 无本轮后端更新 | `fdp-test-app` UPDATE_COMPLETE，LastUpdatedTime 为 `2026-10-03T14:28:37.504Z`；最近事件最终完成于 `2026-10-03T14:29:27.928Z` |
| GitHub 当前流水线 | UNVERIFIED | 查询该 SHA 的 Actions runs 返回 HTTP 404；不据此认定工作流已失败、已跳过或已成功 |
| 当前管理员页面 | 有限只读检查 PASS | 原标签页刷新后仍显示概览，数据基准 2026/10/04 13:02:46；这不证明 Viewer 或停用会话行为 |
| H-01 旧 Token 读写拒绝 | NOT RUN | 缺少包含修复的后端部署版本；此前临时 Token 已销毁，未重新启用历史测试账号 |
| M-01 Viewer 只读访问 | NOT RUN | 本轮未创建新身份，原临时账号已停用；前端部署成功不代替真实 Viewer 登录与非空查询 |

证据：[部署核验回执](evidence/admin-ui-d64af93-recheck-2026-10-04/deployment-verification.json)、[执行器原始字节归档](evidence/admin-ui-d64af93-recheck-2026-10-04/deployment-check-executor.txt)。回执含采集时间、执行器 SHA-256、实际部署字段与历史制品对照。历史来源：[b885e11 制品回执](evidence/qa-09-performance-remediation-2026-10-03/b885e11-application-version.json)。修复说明：[H-01/M-01 本地交付](2026-10-04-admin-ui-h01-m01-remediation.md)。

## 下一步

1. 检查 GitHub Actions 的 **Deploy test API** 工作流在 d64af93 上的状态；其触发条件为 main push 且 `FDP_DEPLOY_ENABLED == 'true'`，先运行 `pnpm verify`，再通过 GitHub OIDC/CDK 更新后端。当前只证明后端未更新，不掌握未更新原因。请提供该提交的工作流运行链接，或使现有只读 GitHub 身份获得该仓库 Actions 读取权限，以便独立核验。
2. 确认该提交的后端工作流成功后，复核 `fdp-test-api` 新代码哈希、CloudFormation 部署制品及源码版本绑定；不要以 Amplify job 52 代替后端证据。
3. 在部署版本通过后，使用新一轮受控测试身份验证：停用前取得有效 Token；业务停用提交后，原 Token GET/POST 均 401，正常账号继续可用。Viewer 可从菜单查询本租户设备用户列表/详情，写入口隐藏、直接 API 写入拒绝、跨 Customer 无泄漏。收尾停用本轮自建对象并销毁私有凭证。
4. 两项目标复验通过后，再推进剩余五角色、非空业务链路、桌面兼容和正式 FE-06～19 目标回执。

本轮未创建或修改账号、业务数据与 AWS 资源，未部署或推送。仅新增本地核验记录；原始 FAIL 证据和正式 Gate 保持不变。

后续诊断：管理员 gh 登录后确认自动发布已触发，并从历史失败日志定位到 QA-05 用例清单/角色矩阵漂移；见 [自动发布诊断](2026-10-04-admin-ui-lambda-auto-deploy-diagnosis.md)。本报告中的旧后端与 404 为当时核验快照，保留历史，不代表工作流最终状态。
