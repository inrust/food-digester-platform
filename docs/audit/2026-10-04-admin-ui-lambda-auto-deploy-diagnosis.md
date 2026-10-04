# 管理后台改版后 Lambda 自动部署阻断诊断

核验对象：`d64af93c30c071b84fba43cebeb91a43e9db865d`。已实时确认 `gh` 活跃账号为 inrust，仓库 `inrust/food-digester-platform` 的 viewerPermission 为 ADMIN，`FDP_DEPLOY_ENABLED=true`。自动发布已触发；此前已完成运行的重复失败原因是 QA-05 验收器清单未跟随新增浏览器用例同步，发布门禁在 AWS 认证之前终止。

## 已确认的历史失败

| 提交 | 后端发布运行 | 实际浏览器结果 | 发布终止原因 |
| --- | --- | --- | --- |
| cb5beaa | [37174383423](https://github.com/inrust/food-digester-platform/actions/runs/37174383423) | 33 passed | test:admin-e2e-suite 抛 INCOMPLETE_BROWSER_EXECUTION |
| bba270d | [37177048416](https://github.com/inrust/food-digester-platform/actions/runs/37177048416) | 33 passed | 相同错误，pnpm verify 退出 1 |

[部署工作流](../../.github/workflows/deploy-test.yml) 的顺序为 pnpm verify → AWS OIDC → 精确账户/SHA 检查 → CDK diff → CDK deploy。verify 失败阻止后续发布，因此 Lambda 保留先前版本。Amplify 前端自动构建独立执行，前端 SUCCEED 不能证明后端发布成功。

## 源码定位与当前提交

1. [run-admin-e2e.mjs](../../scripts/run-admin-e2e.mjs) 的 REQUIRED_TITLES 仍为 30 项；summarizePhase 要求报告和 trace 数量精确等于 30 × repeatEach。UI 改版新增三项测试后，Playwright 默认运行 33 项，即使全部通过仍因数量不匹配失败。
2. 本地对 d64af93 执行 Playwright `--list --reporter=json`，实际注册 **35 项**，原 30 项全部存在，新增五项为 H-01、M-01 和三个桌面分辨率用例。验收器的 30 项清单仍未更新，因此完整执行成功也无法通过当前数量检查。
3. 同一脚本 `/device-users` 的角色矩阵仍不包含 CustomerViewer；当前路由、权限事实和浏览器测试已包含其只读访问。数量修复后，该矩阵也必须同步，否则会报 INCORRECT_ROUTE_MATRIX。
4. 跨阶段隔离检查仍固定 90（原 30 × 串行一次及并行两次）；如果正式纳入 35 项，应为 105。按钮断言统计固定 32，也应随 Viewer 的只读按钮检查同步或从已验证矩阵计算。

这些是验收器与测试集的事实漂移。应保留缺项、未知项、重试、跳过、网络泄露和清理失败的拒绝检查，不能通过删除失败检查、降低 required coverage 或跳过 pnpm verify 恢复发布。

本次 d64af93 的 [Deploy test API](https://github.com/inrust/food-digester-platform/actions/runs/37178464870) 已触发，作业正在执行 pnpm verify；OIDC 和 CDK 步骤尚未开始。CI [37178464946](https://github.com/inrust/food-digester-platform/actions/runs/37178464946) 也处于 verify。本报告的当前运行状态以归档快照为准，不把 in_progress 写成最终失败；上述确定错误已由已结束日志和当前源码清单分别确认。

之前 GitHub 读取 404 的记录保留为历史；本轮管理员登录后已成功读取。此前 H-01/M-01 本地交付完成了相关回归，但未运行完整 QA-05 验收器，漏检这处清单/角色漂移。33/35 项浏览器通过不能替代该组合 Gate。

## 修复建议与验证顺序

1. 更新 QA-05 必需用例清单，正式纳入新增五项；同步 Viewer 只读路由矩阵、执行总数和按钮计数。
2. 增加验收器与 Playwright 实际发现清单的交叉检查，测试缺项、额外项、重复项及角色漂移仍失败关闭，防止只用 REQUIRED_TITLES 自行生成测试数据造成假绿。
3. 运行脚本负向回归、完整 `pnpm test:admin-e2e-suite` 的串行/并行重复阶段，以及完整 `pnpm verify`；处理实际出现的后续问题后生成本地修复提交。
4. 人工通过 GitHub Desktop 推送；确认该新 SHA 的部署工作流最终成功，再核验 Lambda 制品字节/SHA 与源码绑定，随后恢复 H-01/M-01 真实环境复验。

本次仅诊断与保存证据，没有改动源码、工作流、仓库变量或 IAM，没有取消/重跑发布或推送远程。

证据：[诊断摘要](evidence/admin-ui-deploy-diagnosis-2026-10-04/diagnosis.json)、[cb5beaa 失败摘录](evidence/admin-ui-deploy-diagnosis-2026-10-04/cb5beaa-failure-excerpt.txt)、[bba270d 失败摘录](evidence/admin-ui-deploy-diagnosis-2026-10-04/bba270d-failure-excerpt.txt)、[d64af93 当前部署快照](evidence/admin-ui-deploy-diagnosis-2026-10-04/d64af93-deploy-progress.json)。

后续本地修复：已同步 QA-05 清单与 Viewer 矩阵，保留严格检查，并修复完整验证暴露的 QA-08 语义快照漂移；最终 `pnpm verify` 退出 0。见 [修复与回归记录](2026-10-04-admin-ui-qa05-gate-remediation.md)。本报告正文为诊断时快照；本地通过不表示远程工作流或 Lambda 已部署。
