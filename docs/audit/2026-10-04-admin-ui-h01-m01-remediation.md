# H-01 / M-01 修复交付与本地回归

日期：2026-10-04。基线：`bba270d1ce710e6982d019f950beb00d762c8307`。本次交付状态：**源码修复及本地回归 PASS；修复版本的真实目标环境复验 NOT RUN**。原始目标失败及请求 ID 保留在 [目标验收报告](2026-10-04-admin-ui-target-acceptance.md)，不以本地结果覆盖历史证据。

## 修复内容

| 问题 | 根因与修改 | 本地验证 | 目标状态 |
| --- | --- | --- | --- |
| H-01 停用后旧 Token 可访问 API | 认证 Hook 仅处理 INVITED 激活，未拒绝 DISABLED。现有 Hook 每次查询业务用户状态，已停用用户抛出安全的 UNAUTHENTICATED 错误，由 Lambda 返回 401 并阻断路由解析/执行；条件激活失败时重新检查状态，拒绝查询后已被停用的邀请用户。 | 五角色 × ID/Access Token：正常状态读写可进入路由；通过真实领域停用服务提交 DB 状态后，原 Token 原样重用的 GET/POST 均 401，路由零调用、无额外业务审计；邀请期间停用无激活审计。首次激活和 ACTIVE 幂等测试继续通过。 | FIXED LOCALLY / TARGET RECHECK REQUIRED |
| M-01 Viewer API 可读但页面拒绝 | BE-DUSR-01 规范和 AUTH-01 共享权限明确包含 CustomerViewer；`/device-users` 为 CT-06 矩阵外扩展路由。按共享 device-user:read 生成路由角色，菜单随路由生成，Viewer 可进入只读页面；更新 FE-09 文档。 | 五角色路由/菜单与共享权限一致；Viewer 从菜单查看非空列表、详情，六个写入口隐藏且仅产生 GET；PGlite PostgreSQL 服务测试验证自有读取、跨租户详情 404、外租户筛选无泄漏，以及创建/更新/停用/分配/撤销均 403。 | FIXED LOCALLY / TARGET RECHECK REQUIRED |

H-01 代码：[user/service.ts](../../apps/cloud-api/src/admin/user/service.ts)。生产入口继续通过 [lambda-entry.ts](../../apps/cloud-api/src/runtime/lambda-entry.ts) 的 onAuthenticated Hook 调用该服务，JWT 验签和权限 Guard 保持生效。使用已有账号状态查询，不缓存该状态，也不增加每请求 Cognito 管理调用。401 后前端按既有策略尝试刷新一次，刷新被拒绝后清会话并返回登录。

边界：本次保证已提交为 DISABLED 的业务账号在后续请求的入口检查中被拒绝；不承诺撤回已经通过入口检查的在途操作。无对应业务用户记录的启动账号保留既有行为。仅在 Cognito 控制台停用、GlobalSignOut 或角色/Scope 变更的独立即时撤销策略不由本次修复扩展。没有修改 API 角色权限、冻结策略或原有账号；没有操作 AWS、重新启用已清理测试对象或部署目标环境。

## 回归证据

| 检查 | 结果 |
| --- | --- |
| 全量 Vitest | 165 文件、1340 测试 PASS |
| 后续相关服务回归 | 测试查询替身的 Prisma 返回类型修正后，admin-user/admin-device-user 两文件 39 测试 PASS；业务源码未再变化 |
| 契约测试 | 301 PASS，冻结角色策略不变 |
| 仓库脚本测试 | 407 PASS |
| 类型检查 | 21 工作区 PASS（包括管理后台 E2E 类型） |
| 四浏览器相关回归 | Chromium、安装版 Chrome、Firefox、安装版 Edge 各 7 项，共 28 PASS；覆盖五角色路由/按钮矩阵、H-01 会话退出及 M-01 Viewer 只读查询 |
| 构建 | Playwright 启动前 admin-web TypeScript/Vite 构建 PASS；交付 Gate 验证浏览器制品 |
| 质量 Gate | ESLint、Prettier、模块边界、Schema、敏感信息、日志/Trace 敏感 sink、后台交付、129 个生产 REST operation 与 OpenAPI 一致性、git diff --check PASS |

浏览器首次执行：24 PASS / 4 FAIL，均为新增 H-01 测试未模拟 Cognito 刷新请求，fixture 按规则阻断外部请求。补充明确的 NotAuthorizedException 刷新响应后，完整重跑 28 PASS；未放开网络拦截或弱化断言。首次和最终日志均保留。脚本测试首次因沙箱禁止 localhost 监听失败，允许本地服务后重跑 407 PASS。

本地证据：[verification.json](evidence/admin-ui-h01-m01-2026-10-04/verification.json)、[浏览器首次失败](evidence/admin-ui-h01-m01-2026-10-04/browser-initial.txt)、[浏览器最终通过](evidence/admin-ui-h01-m01-2026-10-04/browser-final.txt)。回执记录被测源码/测试文件 SHA-256、命令和结果，属于本地回归证据，不能替代正式目标 Gate。

## 下一步

后续状态（2026-10-04，保留上表的修复时点结论）：`3f54e8a` 已完成 CI、真实部署制品绑定及 H-01 / M-01 限定范围目标复验。旧且未过期 ID Token 的读写均 401 / UNAUTHENTICATED；真实 Viewer 可访问自有非空列表和详情，六类写入均 403、写控件隐藏。详见 [目标复验报告](2026-10-04-admin-ui-3f54e8a-target-recheck.md)。正式五角色、全业务和 FE-06～19 回执仍需单独补齐。

1. 人工通过 GitHub Desktop 推送本地修复提交，核验该应用版本的 CI、前端部署及后端 Lambda 制品。
2. 在现有 `fdp-test-app` 创建新一轮隔离对象：停用前取得有效会话；停用完成后原 Token 的读取与写入均须返回 401，正常账号仍可使用；保留请求 ID、审计和收尾台账。此前账号与记录保持停用。
3. 真实 CustomerViewer 验证设备用户菜单、筛选和详情可读，写入口不可用，直接 API 写入拒绝、跨 Customer 无泄漏。
4. 关闭 H-01/M-01 的目标复验后，再补五角色、非空业务链路、目标桌面兼容和正式 FE-06～19 回执；生产验收单独核实环境和范围。

本次仅创建本地 Git 提交；远程推送由人工执行。
