# 3f54e8a CI、部署与 H-01 / M-01 真实目标复验

结论：`3f54e8a18314c90a366d2d919c11f33faf1e209b` 的 CI、后端自动部署、前端发布及 Lambda 制品绑定通过；H-01 的业务停用后旧 ID Token 读写拒绝、M-01 的 Viewer 自有非空数据只读访问通过本轮真实目标复验。本次无需修改业务代码。

环境为 AWS `065986019555 / ap-southeast-1 / fdp-test-app`，管理员页面 `https://admin.bio-nexa.com`、API `https://api.bio-nexa.com/api/v1`。这是现有真实测试环境，不能据域名或真实数据将其称为生产验收。`productionAccepted=false`、`fullAdminTargetAccepted=false` 保留。

## 版本与自动部署

| 检查 | 当前证据 | 结果 |
| --- | --- | --- |
| GitHub CI | [37184602184](https://github.com/inrust/food-digester-platform/actions/runs/37184602184)，headSha 为完整 `3f54e8a`，completed/success | PASS |
| GitHub Deploy test API | [37184602130](https://github.com/inrust/food-digester-platform/actions/runs/37184602130)，相同 headSha，OIDC/CDK 部署完成 | PASS |
| QA-05 | serial 35 + parallel/repeat 70；两阶段 timeout=645000ms，实际耗时 232534ms / 389931ms；并行 70 次全部通过 | PASS |
| QA-08 | 24 次原型回归通过 | PASS |
| CloudFormation | `fdp-test-app` UPDATE_COMPLETE，API Lambda 于 07:43 UTC 更新完成 | PASS |
| Lambda 制品 | 当前模板引用的 S3 不可变版本 ZIP，327 个有界分片重新组装并计算 SHA256；19 个制品均等于当前 Lambda CodeSha256，Active / Successful | PASS |
| API Lambda | LastModified=2026-10-04T07:43:08Z；CodeSha256=`OAYVGE/H/Ia7iNoTDMY8i3UKNTeUthGgkPoPPqoeYYE=` | PASS |
| Amplify main | job 54、完整 `3f54e8a`、SUCCEED | PASS |
| 验收后漂移检查 | API CodeSha256 和 RevisionId 未变；Amplify 仍为 job 54 / 相同 SHA | PASS |

Ubuntu 上并行阶段约 390 秒，实际超过原来的 240 秒上限；本次不是放宽测试清单，而是既有 645 秒预算允许严格的 35/70 回归完成。

原始证据：[版本字节回执](evidence/admin-ui-3f54e8a-recheck-2026-10-04/application-version.json)、[CI](evidence/admin-ui-3f54e8a-recheck-2026-10-04/ci-run.json)、[部署](evidence/admin-ui-3f54e8a-recheck-2026-10-04/deploy-run.json)、[部署日志节选](evidence/admin-ui-3f54e8a-recheck-2026-10-04/deploy-evidence-excerpts.txt)、[验收后版本](evidence/admin-ui-3f54e8a-recheck-2026-10-04/post-acceptance-version.json)。

## 测试对象与安全边界

仅新增本轮 `UI-RECHECK-3F54E8A-20261004` 命名空间的 2 Customer、2 Site、1 DeviceUser 和 2 Cognito 用户。用户在邀请表单准备完成后确认新账号的角色、范围及验收后停用；两个账号均限定 Customer A，Customer B / Site B 作为已知的外租户查询对象。

| 对象 | ID / 用户名 | 用途 |
| --- | --- | --- |
| Customer A | `812d9906-9b86-4c52-81fd-b1ad491181d9` | 两角色共同的隔离数据范围 |
| Customer B | `88a40e32-7c0a-4eeb-8524-d7cc5756f8f2` | 外租户过滤及 Site B 查询拒绝 |
| Site A | `de61e0ee-d5db-4ab8-ae72-698673c16a1b` | 正常查询 / 停用后的同路径查询 |
| Site B | `64bc8039-7a09-4498-bfb4-f37d944a716e` | 外租户详情拒绝 |
| DeviceUser A | `14bce792-5988-4eca-b281-f74987925849` | Viewer 非空列表、详情、六类写入拒绝 |
| CustomerAdmin A | `ui-recheck-3f54e8a-admin@example.invalid` | 正常写入及业务停用后的旧会话 |
| CustomerViewer A | `ui-recheck-3f54e8a-viewer@example.invalid` | 同一份数据的只读访问、停用对照 |

此前 `UI-ACCEPT-20261004` 账号、Customer、Site、DeviceUser 继续停用，未重置其凭证或修改其记录。没有分配真实设备、发出设备命令、更改 IAM、重新部署或推送 Git。

## H-01：业务停用后旧 Token 读写拒绝

通过应用的 AuthFlow 执行真实 Cognito SRP。正常 ID Token 的 Site A 查询为 200；Admin 创建 DeviceUser 的写入基线为 201。首次采集在浏览器阶段前因标准输入关闭退出，201 原始基线保存在首轮回执；恢复采集后使用相同授权账号的新会话和已创建的同一条记录，重新验证自有查询和 Viewer 写入拒绝，再保留这次会话的 Token 等待 UI 停用。

管理员 UI 逐一停用两个新业务账号，列表读回“已停用”，Cognito Enabled=false。下列请求复用各账号**停用前保存的同一 ID Token**，SHA256 未变、有效期尚未到期，未通过重新登录替换 Token：

| 账号 | 操作 | 结果 | 请求编号 |
| --- | --- | --- | --- |
| CustomerAdmin | GET Site A | 401 / UNAUTHENTICATED | `81fca4ba-e6f5-4bb6-b7b6-4bb056db5cf4` |
| CustomerAdmin | POST DeviceUser（自有范围） | 401 / UNAUTHENTICATED | `509a61f0-439a-41e4-86b3-3163157f58f8` |
| CustomerViewer | GET Site A | 401 / UNAUTHENTICATED | `30f04bcf-96d0-4847-b631-2e35b4bf785c` |
| CustomerViewer | POST DeviceUser（自有范围） | 401 / UNAUTHENTICATED | `3450d36e-59d7-486d-bd58-ff18a512d1d2` |

Admin 的 ID Token 在 08:43:43 UTC 签发、09:43:43 UTC 到期；Viewer 为 08:43:51 / 09:43:51 UTC。采集结束约 08:47 UTC，拒绝不依赖自然过期。

Admin 停用后、Viewer 停用前，Viewer 的同路径查询仍为 200（请求编号 `9a863d16-02f6-4002-ae62-24bfc0d3b6d9`），排除整个 Customer 或 API 失效导致的假阳性。两账号停用后新 SRP 登录均报 INVALID_CREDENTIALS；已有 Viewer 浏览器会话刷新后回到登录页。

Access Token 的正常账号读写基线即为网关 401，停用后也为 401。后台 REST 客户端使用 ID Token（见 `apps/admin-web/src/api/http-client.ts`）；Access Token 的这些负向请求只能证明网关拒绝，不能单独证明业务停用或撤销效果。首轮曾将 Access Token 正常查询误设为预期 200，保留该失败，恢复采集时按实际 REST 认证边界单列检查；ID Token 的前后对照及 401 / UNAUTHENTICATED 严格检查保留。

本轮证明的是**业务账号 DISABLED 已提交后的新请求拒绝**，不扩展到停用提交前已在处理中的请求，也不声称单独 Cognito GlobalSignOut 对所有 JWT 请求即时生效。

## M-01：Viewer 自有非空数据只读

真实 Viewer 登录后，菜单包含“设备用户”，`/device-users` 正常进入；列表显示本轮唯一 DeviceUser，详情显示 Customer A 和 v1。新建、编辑、重置密码、停用、分配、撤销六个控件在真实 DOM 中均为 0 个。

| 检查 | 结果 |
| --- | --- |
| API 自有非空列表 / 详情 | 200，精确匹配本轮 DeviceUser ID 和 Customer A |
| 创建、编辑、密码轮换、停用、分配、撤销直接 API 调用 | 六类均 403 |
| 写入拒绝后的 Admin 读回 | status、displayName、version 均未变 |
| 两角色对 Site B 详情查询 | 403 / 404 拒绝 |
| 外 Customer Site 过滤 | 拒绝或不泄露外租户数据 |
| Viewer 浏览器菜单 / 路由 / 非空列表 / 详情 | PASS，未 mock / 拦截请求 |

分配 / 撤销拒绝使用不存在的 UUID，验证权限检查先于业务查询；没有绑定设备或改变已有设备授权。本轮不将该检查称为真实设备分配业务验收，也未新增 Customer B 的非空 DeviceUser 双租户全矩阵。

[API 及会话回执](evidence/admin-ui-3f54e8a-recheck-2026-10-04/session-and-viewer-recheck.json) 的最终结果为 `PASS_SCOPED_H01_M01`：32 个请求、68 项断言全部通过，并保留请求编号、Token 摘要和有效期；没有保存 Token、密码、AWS 凭证或完整 API 响应体。[浏览器回执](evidence/admin-ui-3f54e8a-recheck-2026-10-04/viewer-browser.json)、[只读 DOM](evidence/admin-ui-3f54e8a-recheck-2026-10-04/viewer-dom.txt)、[只读截图](evidence/admin-ui-3f54e8a-recheck-2026-10-04/viewer-readonly.jpg)、[旧浏览器会话回到登录页](evidence/admin-ui-3f54e8a-recheck-2026-10-04/viewer-session-rejected.jpg)。

## 清理与可追溯性

7 个本轮对象全部停用：DeviceUser 在停用账号前通过 If-Match=1 停用，读回 v2 / DISABLED；两个账号通过管理员页面停用并查询 Cognito Enabled=false；两个 Site 和两个 Customer 通过各自详情页停用，读回已停用。记录保留用于审计，没有永久删除。

[对象清单](evidence/admin-ui-3f54e8a-recheck-2026-10-04/owned-fixture-ledger.json)、[账号停用 DOM](evidence/admin-ui-3f54e8a-recheck-2026-10-04/accounts-disabled-dom.txt)、[Site 停用 DOM](evidence/admin-ui-3f54e8a-recheck-2026-10-04/sites-disabled-dom.txt)、[Customer 停用 DOM](evidence/admin-ui-3f54e8a-recheck-2026-10-04/customers-disabled-dom.txt)、[DeviceUser 停用 DOM](evidence/admin-ui-3f54e8a-recheck-2026-10-04/device-user-disabled-dom.txt)。

临时登录文件已删除；采集进程销毁会话与 Cognito 客户端；浏览器临时账号密码变量已清空、测试标签页已关闭，原管理员及 GitHub 用户标签页保留。

首轮输入通道关闭的[原始回执](evidence/admin-ui-3f54e8a-recheck-2026-10-04/attempt-1-input-closed.json)、[执行器原始字节](evidence/admin-ui-3f54e8a-recheck-2026-10-04/attempt-1-executor.mjs.txt)和[对象清单快照](evidence/admin-ui-3f54e8a-recheck-2026-10-04/attempt-1-fixture-ledger.json)保留。最终执行器要求交互输入通道，并仅允许精确的本轮中断恢复；禁用后或 HEAD 改变不能再次复用这些账号。此前 cb5beaa 的 H-01 / M-01 失败证据不覆盖、不删除。

执行器为 `scripts/verify-admin-ui-3f54e8a-recheck.mjs`；最终回执 executorSha256 绑定执行字节。证据提交仅含采集脚本及审计材料，业务部署仍绑定已推送的 `3f54e8a`，不是将新证据提交冒充为已部署版本。

## 验证及下一步

本轮静态检查、输入关闭安全拒绝和本地完整回归结果见 [本地验证回执](evidence/admin-ui-3f54e8a-recheck-2026-10-04/local-validation.json)。[证据完整性检查](evidence/admin-ui-3f54e8a-recheck-2026-10-04/evidence-integrity.json)核对执行字节、制品回执绑定、有效 ID Token 前后对照、六类写入拒绝、真实非空 UI、七对象停用、凭证删除及业务工作树未变。

完整 `pnpm verify` 退出码 0：单元 1340、契约 301、脚本 434、基础浏览器 35、QA-05 105、QA-08 24 均通过，七个新生成的本地 Gate 回执均 PASS。首次执行因沙箱禁止本地 TLS broker 监听 `::1` 而退出；保留该环境中断，在允许本机测试端口的执行环境重跑完整流水线通过，没有降低断言或跳过套件。[日志节选](evidence/admin-ui-3f54e8a-recheck-2026-10-04/local-verify-excerpts.txt)记录本轮结果；本地测试继续按模拟/本地范围解释。

发布前 [敏感内容扫描](evidence/admin-ui-3f54e8a-recheck-2026-10-04/publication-scan.json)通过；[制品摘要清单](evidence/admin-ui-3f54e8a-recheck-2026-10-04/artifact-hashes.json)绑定各证据文件及最终采集脚本。Git 提交不含临时密码或 Token。

DOM 文本和日志节选仅去除行尾空白以满足 Git 空白检查；业务内容不变，执行器原始字节和 JSON 回执未重写。

1. H-01 / M-01 可按上述范围关闭目标复验项；其他原始结论继续按历史报告保留。
2. 下一批优先补五角色及两租户非空业务矩阵，覆盖查询导出、审批、配置发布、设备业务等正常与拒绝链路，生成正式 FE-06～19 目标回执。
3. 在同一待验收应用版本上补实际 Chrome / Edge / Firefox 桌面执行及 1366×768 以上分辨率。当前真实 UI 证据来自 Codex IAB，不替代三浏览器兼容验收。
4. 稳态并发容量 / SLO、真实设备、生产环境验收继续单独建立对象与回执。现有 formal target Gate 不改成 PASS。

相关历史：[首次真实验收](2026-10-04-admin-ui-target-acceptance.md)、[H-01 / M-01 本地修复](2026-10-04-admin-ui-h01-m01-remediation.md)、[d64af93 部署复查](2026-10-04-admin-ui-d64af93-deployment-recheck.md)、[af15a08 CI 超时修复](2026-10-04-admin-ui-af15a08-ci-timeout-remediation.md)。
