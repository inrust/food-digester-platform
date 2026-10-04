# 管理后台 QA-05 部署门禁修复与完整回归

任务：同步验收器清单和权限矩阵，保留严格检查，通过完整 `pnpm verify` 后生成本地提交。基线为 `d64af93c30c071b84fba43cebeb91a43e9db865d`；本次验证最终工作树文件的 SHA-256，随后提交相同字节。最终完整验证状态：**PASS，退出码 0**。本轮不推送、不部署。

## 修复结果

1. [QA-05 执行器](../../scripts/run-admin-e2e.mjs) 显式保留原 30 个用例并纳入 H-01、M-01 和三个桌面尺寸回归，共 35 个。运行前独立调用 Playwright `--list --reporter=json` 与必需清单核对；缺项、额外项、重复标题、错误 project/repeat/retry 配置均拒绝。
2. Viewer 的 `/device-users` 路由预期同步为允许只读，创建按钮仍隐藏；平台 Operator 仍无该路由权限。权限矩阵保持独立预期，不从生产权限函数推导。按钮计数从已通过严格矩阵校验的轨迹计算，当前每轮 33 项；22 路由 × 5 角色仍为 110 项断言。
3. H-01/M-01 用例记录关键断言后的行为证明。三个桌面用例同时使用 QA-05 隔离/网络记录和 QA-08 数据夹具，完成路由、布局、键盘及语言断言后才记录对应证明；不能只通过修改数量纳入没有轨迹的测试。
4. 两阶段各 35/70 次，跨阶段总数由已验证阶段推导为 105，所有前缀必须唯一。缺项、跳过、重试、flaky、角色/按钮偏差、关键证明缺失、网络泄露、清理失败和运行期间源码变化的拒绝逻辑保留，超时及执行阶段保持原配置。

## 完整验证发现的后续阻断

第一次完整 `pnpm verify` 在 QA-08 原型回归失败：24 项中 12 项的语义快照未同步既有 UI 改版。原始失败保存为 [摘录](evidence/admin-ui-qa05-gate-2026-10-04/first-verify-qa08-failure.txt) 和 [摘要](evidence/admin-ui-qa05-gate-2026-10-04/first-verify-summary.json)，不改写成 PASS。

逐项审查了六页面 × 375/1440px 的 12 份快照：只增加概览、设备状态监测、远程设备操作、设备群总览、ESG 数据总览、设备 ESG 数据的页面标题，以及两份概览中的刷新按钮。核对生产页面及失败差异，并执行结构比较：移除这些新增项后，新 JSON 与 HEAD 原快照完全相等。所有原有列、按钮、标签和四轴值完整保留。

没有启用 `QA08_UPDATE` 作为回归，也没有修改快照采集、严格相等检查、覆盖组/菜单绑定、快照哈希或更新模式拒绝条件。QA-08 仍执行全部 24 用例。同步 [QA-05 文档](../dev/QA-05-管理后台E2E测试.md) 和 [QA-08 文档](../dev/QA-08-客户原型追踪与视觉行为回归测试.md)。

## 验证与边界

QA-05 验收器正负测试共 33 项通过，包括实际 Playwright 发现清单核对、缺/多/重复用例、旧 Viewer 矩阵、各专项关键证明缺失，以及跨阶段前缀复用拒绝。最终完整 `pnpm verify` 退出 0：

| 检查 | 最终结果 |
| --- | --- |
| lint / format / typecheck / OpenAPI | PASS |
| 单元测试 | 165 文件、1340 项 PASS |
| 契约测试 / 脚本测试 | 301 / 422 项 PASS；脚本包含 QA-05 33 项正负测试 |
| 构建 / 边界 / Schema / 迁移 / 已有证据 / 敏感信息与日志落点 / 前端交付 | PASS |
| 默认 Chromium 浏览器回归 | 35 项 PASS |
| Runtime / CDK synth | PASS |
| QA-02 / QA-03 / QA-04 | 各本地回执 PASS |
| QA-05 | 35 用例，串行 35、双 worker 重复 70；总计 105，路由断言 110/220，按钮断言 33/66 |
| QA-06 / QA-07 | 各本地回执 PASS |
| QA-08 | 24 用例、24 快照 PASS，更新模式关闭 |

归档 [最终验证摘要](evidence/admin-ui-qa05-gate-2026-10-04/verify-summary.json)、[成功日志摘录](evidence/admin-ui-qa05-gate-2026-10-04/verify-success-excerpt.txt)、[QA-05 完整回执](evidence/admin-ui-qa05-gate-2026-10-04/qa05-receipt.json) 和 [QA-08 完整回执](evidence/admin-ui-qa05-gate-2026-10-04/qa08-receipt.json)。摘要保存完整本地日志的 SHA-256、各 QA 回执的哈希与采集时间、16 个变更源文件的哈希及快照差异审查。QA-05 的 187 个来源和 QA-08 的 266 个来源在最终运行后与当前文件完全匹配。第一次 [QA-08 FAIL 回执](evidence/admin-ui-qa05-gate-2026-10-04/first-qa08-fail-receipt.json) 保留。

验证环境为 Node 24.12.0、pnpm 10.20.0、OpenSSL 3.5.0 和本地无头 Chromium。OpenSSL 使用已安装的 Homebrew 3.x 可执行程序，未降低 TLS 要求。浏览器通过生产构建运行，认证/API 使用独立本地夹具。本次未重跑 Edge/Firefox/WebKit；此前兼容性证据保持历史属性。

这是本地发布门禁修复，不能证明 Lambda 已更新或 H-01/M-01 真实 Cognito/API 复验通过；目标 Gate 仍为 `NOT RUN / NO RECEIPT`。先前 [部署核验](2026-10-04-admin-ui-d64af93-deployment-recheck.md) 和 [自动部署诊断](2026-10-04-admin-ui-lambda-auto-deploy-diagnosis.md) 的快照与失败证据保留。

## 下一步

1. 人工通过 GitHub Desktop 推送本次本地提交，确认新 SHA 的 CI 与 Deploy test API 均最终成功；不能用 Amplify 前端构建成功替代后端发布。
2. 核验 Lambda 制品哈希、CloudFormation 和工作流对应同一提交，再恢复真实测试环境 H-01/M-01 验收：旧 Token GET/POST 拒绝；Viewer 本租户非空查询与详情可用、写入口隐藏、直接写 API 拒绝、跨 Customer 无泄漏。
3. 收尾停用本轮受控测试身份和记录并销毁凭证；通过后继续剩余业务链路及正式 FE-06～19 目标环境回执。
