# QA-05 管理后台 E2E 测试

依据 [开发任务清单](../管理后台开发任务清单.md#qa-05-建立管理后台-e2e-测试)。FE-01～19 已接入管理后台组合根，QA-02/03/04 提供独立的契约、IoT 链路和业务 API 本地测试。QA-05 运行生产构建的管理后台及真实无头 Chromium，API、Cognito、媒体由每个测试的本地网络夹具提供。

## 执行

```sh
pnpm check:admin-web-e2e
pnpm test:admin-e2e-suite /tmp/qa05-local-e2e.json
node --test scripts/admin-e2e.test.mjs
pnpm --filter @fdp/admin-web typecheck
pnpm verify
```

预先安装仓库锁定依赖与 Playwright Chromium；默认端口 `127.0.0.1:4173` 必须空闲。测试不自动安装浏览器，不复用已有服务器。受限沙箱需要允许本地监听及 Chromium 进程；监听失败属于执行环境问题，不能生成 PASS。`verify` 包含一次 35 项浏览器回归，以及 QA-05 的 35 项串行、70 项双 worker 重复执行，全部禁用 retries。

## 测试与隔离

| 文件 | 用途 |
| --- | --- |
| `apps/admin-web/e2e/admin-web.spec.ts` | 既有 21 项 FE-01～19 回归及 H-01/M-01 两项，共 23 项浏览器用例 |
| `apps/admin-web/e2e/ui-redesign.spec.ts` | 1366×768、1440×900、1920×1080 的全部业务路由、键盘与语言回归；同时记录 QA-05 隔离/网络证明 |
| `apps/admin-web/e2e/qa05-workflows.spec.ts` | 五角色全路由/菜单/写入口矩阵，以及登录、ESG、Command、Media/Audit 四个专项流程 |
| `apps/admin-web/e2e/qa05-api-fixtures.ts` | 克隆响应模板、会话、API 及像素媒体夹具，不注册测试 |
| `apps/admin-web/e2e/qa05-fixture.ts` | 自动网络阻断、每项随机前缀、独立 Context、响应摘要和清理 |
| `apps/admin-web/playwright.config.ts` | Chromium、生产构建、零重试、串行/并行重复配置及 JSON reporter |
| `apps/admin-web/tsconfig.e2e.json` | E2E/config 严格类型检查，接入应用 typecheck |
| `scripts/run-admin-e2e.mjs` | 执行两阶段、失败关闭验收、生成来源 Hash 与本地回执 |
| `scripts/admin-e2e.test.mjs` | 验证 Gate 对缺用例、重试、跳过、权限偏差、复用数据及未模拟网络的拒绝行为 |

每项测试重新创建 Context、sessionStorage、本地响应及闭包中的业务状态，不共享服务器数据库。模板只读使用，`json` 通过 structuredClone 创建独立响应；相同固定业务 ID 属于不同 Context/网络路由的命名空间。新增有状态业务记录使用 `QA05-<随机前缀>`。需要额外页面的旧测试统一通过 `qa05.newPage()` 创建并登记 Context。teardown 关闭所有 Context；runner finally 删除临时报告和 trace。因而清理不会触及外部业务数据。

除了明确模拟的路由，仅允许本地预览源上的静态资源通行。未模拟 API/外部请求阻断并令测试失败，Service Worker 禁用。Cognito URL 同样由 route.fulfill 返回脚本响应，无真实认证调用；图片由本地 1px PNG 替身返回。临时 trace 只记录用例、随机前缀、状态、API 路径/方法/状态码及断言证明；最终回执保留响应数量和状态码摘要，不保存请求体、Token 或密码。

## 覆盖

- 登录：SRP PASSWORD_VERIFIER、MFA 错误重试/成功、Logout、过期 Token 刷新失败清会话、无 Token 回登录；验证原始密码不进入请求和 Web Storage。
- 五角色：22 个受保护路由 × 5 = 110 项允许/403 断言；菜单出现/隐藏；10 类写入口在可访问路由上形成 33 项按钮断言，包含 Customer 角色用户/耗材/站点边界及 Auditor OTA 禁用。
- Onboarding、Customer/Site、Device、Contract、License、配置、用户、Consumable、Alarm：既有生产页面 CRUD/审批/生命周期/绑定解绑/邀请/申请状态机，Customer scope、404、空态、409、重复提交及键盘边界。
- ESG：两页游标的汇总一致性、导出请求使用相同日期范围、America/New_York 本地日转换为 UTC 边界、刷新后时区保持、空态。
- Command：SHUTDOWN 错误确认阻止写入，正确确认后创建、SUCCEEDED、PUBLISH_FAILED 页面结果。
- OTA：包/灰度/终态相关页面与角色入口；新增 Auditor 禁用创建的产品修复和组件回归。平台 Operator/SuperAdmin 可用，服务端权限仍独立强制。
- Media/Audit：返回已过期 URL 时不渲染图片、续签恢复、403 撤销预览与下载；Audit 展示脱敏内容、查询不发写请求。
- FE-19：zh-CN/en × 375/768/1440 三种宽度，22 个生产路由布局与语言持久化。

## Gate 与验收边界

Gate 显式登记 35 个必需用例，先与 Playwright 实际发现清单严格交叉核对（缺项、额外项或重复项均拒绝），两阶段分别验证 35/70 次通过、无 skip/flaky/retry、每次独立前缀和成功清理、无未模拟网络。Playwright JSON reporter 不暴露每项 repeatEachIndex；因此使用配置中的 repeatEach、每个标题的执行数，以及 fixture 逐次记录的 repeat 索引联合校验。权限预期矩阵独立写在 Gate 中，不从生产权限函数推导。关键流程须有成功断言后的证明，403/409 必须有观察到的 API 响应。源码在运行前后 Hash 不一致会拒绝 PASS。跨阶段总数由已验证阶段计算，当前为 105；所有前缀必须跨阶段唯一。

阶段总时间预算为构建/启动 120 秒，加上 `ceil(35 × repeatEach / workers)` 个执行槽 × 15 秒，最多 900 秒。当前串行和双 worker 重复阶段均为 645 秒（10 分 45 秒）。这是整个子进程的有界执行预算，包含启动和所有用例，单用例 timeout、零重试及覆盖要求保持不变。阶段日志和回执记录预算与实际耗时；子进程 ETIMEDOUT 明确报 `BROWSER_PHASE_TIMEOUT`，仍写 FAIL，不能接受部分执行。策略由源码管理，不允许环境变量关闭或任意放大预算。变更原因见 [af15a08 CI 超时修复](../audit/2026-10-04-admin-ui-af15a08-ci-timeout-remediation.md)。

并行/重复执行验证了当前调度下的数据隔离和稳定性，不能穷举所有可能执行顺序。未运行真实 Cognito/API/RDS/S3/IoT 集成、真实签名验证、生产冒烟或人工验收；脚本认证和 UI 状态不得当作目标环境成功。本地 QA-05 Gate PASS 与真实 AWS 验收分别报告，后者继续由既有三个 admin-web target-evidence Gate 及 exact-commit 结构化回执控制。

2026-10-04 纳入 H-01 会话退出、M-01 Viewer 只读查询和三个桌面尺寸 UI 回归；桌面用例合并 QA-05 隔离/网络记录与 QA-08 数据夹具，关键行为断言完成后才记录证明。Viewer 可读取设备用户，写按钮隐藏；平台 Operator 仍无设备用户权限。

历史验收记录与回放摘要见 [QA-05 本地验收记录](../audit/QA-05-本地验收记录-2026-10-01.md)。2026-10-04 清单与权限矩阵修复见 [QA-05 部署门禁修复记录](../audit/2026-10-04-admin-ui-qa05-gate-remediation.md)，同时记录完整 verify 中发现的 QA-08 快照同步及最终回归结果。
