# BE-CMD-01 Command 创建与授权 API

实现：[apps/cloud-api/src/admin/command/](../../apps/cloud-api/src/admin/command/index.ts)（errors/service/handler）；领域：[packages/domain/src/command.ts](../../packages/domain/src/command.ts)；OpenAPI：[contracts/rest/admin-command-api.json](../../contracts/rest/admin-command-api.json)；验收测试：[admin-command.test.ts](../../apps/cloud-api/test/admin-command.test.ts) + [command.test.ts](../../packages/domain/test/command.test.ts)。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CMD-01（P1），依赖 CT-04（command-catalog 1.0.1，22 命令白名单）、AUTH-01、BE-DEV-01、BE-LIC-01、DOM-03 |
| 功能边界 | 不发布 MQTT（发布属 BE-CMD-02）、不执行设备动作 |
| 存储 | `device_commands` 表已就绪（无需 migration）：highRisk/confirmedBy/expiresAt/version 齐备 |

## 2. 校验链与设计

`POST /api/v1/admin/devices/{deviceId}/commands`（command:send = SuperAdmin/Operator/CustomerAdmin）：

1. **角色**：AUTH-01 权限门；
2. **Customer 租户**：Customer 角色跨 Customer → 404（不泄露存在性）；设备未分配 Customer → 400；
3. **设备状态门**：`resolveCommandGateStatus`（云端权威优先：lifecycle Retired → RETIRED 拒绝全部；Suspended → SUSPENDED；否则设备上报 operationalStatus，无上报按 ACTIVE）+ 目录 `allowedStatuses` 门控 → DEVICE_STATE_NOT_ALLOWED 409；
4. **Entitlement**：设备有效 License（Active/ExpiringSoon 且在窗口内）且 REMOTE_CONTROL enabled → 无则 403 FORBIDDEN；
5. **白名单/参数/timeoutSec**：未知命令 400；timeoutSec 整数 1~3600（上限暂定值）；remarks ≤500；
6. **DEC-023 高风险确认**（目录中标记 highRisk 的命令）：请求只允许 `confirmation = { confirmText }`，文本须精确匹配命令名；认证时间仅取已验签 Cognito JWT `auth_time`，按 `command.confirmation` 的 TTL/时钟漂移策略校验，缺失/过期/未来值 → 403 并要求重新认证；客户端 `confirmedAt` 被拒绝；该语义不声明 MFA 或双人审批；
7. **落库 AUTHORIZED**（创建即授权）+ DOM-03 审计 command.authorize。

**meta.id 即 commandId**（DEC-006）：客户端可提供 commandId 幂等键；重复创建（同 id 且 device/command/timeoutSec 语义一致）→ 200 replayed=true 无新写入/审计；语义冲突 → 409 CONFLICT；并发 P2002 兜底重读分类。缺省由服务器生成（表无 DB 默认值，审计 objectId 用真实 commandId）。

**服务器权威字段**：requestedBy 取身份上下文（客户端声明被忽略）；requestTime = now；expiresAt = requestTime + timeoutSec 内部计算。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 22 个命令矩阵覆盖 | 领域层目录一致性（逐字段对齐 catalog 1.0.1）+ API 级 ACTIVE 全量 22 创建成功（AUTHORIZED、category/highRisk/confirmedBy 断言） | ✅ |
| Suspended/Retired 限制正确 | SUSPENDED 逐命令断言（allowed 子集 201、其余 409 DEVICE_STATE_NOT_ALLOWED）；MAINTENANCE 同 Suspended；RETIRED 全部 409 | ✅ |
| 无 Entitlement 失败 | 无 License / Entitlement disabled / License 过期 / 仅 OTA_UPDATE → 全部 403 | ✅ |
| 确认与重新认证失败关闭 | 缺确认/文本不符/客户端时间字段 → 400；JWT `auth_time` 缺失/过期/未来 → 403；全部不落库 | ✅ |
| 越权失败 | CustomerViewer/Auditor → 403；跨 Customer → 404；未认证 → 401；Operator 放行 | ✅ |
| meta.id 幂等 | 重复创建 200 replayed（无新写入/审计恰好 1 条）；语义冲突 409 | ✅ |
| 服务器权威字段与审计 | body.requestedBy/requestTime/expiresAt 被忽略；expiresAt 内部计算；审计记录 DEC-023、确认方式、actor 与可信 authenticatedAt | ✅ |
| 契约一致性 | 响应字段与 OpenAPI 封闭一致；错误码对齐 CT-05；模块无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-command-api.test.ts`（4 项：端点/响应码、22 命令枚举与目录一致、Schema 封闭、$ref 可解析）。

## 4. 未决风险

- timeoutSec 上限 3600s、remarks 500 仍为模块级限制；确认窗口由 `command.confirmation` 业务设置管理；
- DEC-023 只证明近期重新认证与显式文本确认，不证明 MFA 或双人审批；如需增强必须提升决策版本并引入可验证凭证；
- 状态机后续节点（PUBLISHED/ACKNOWLEDGED/超时扫描）属 BE-CMD-02/03；命令查询/取消 API 未在本任务范围；
- 领域层目录常量与契约目录双写（一致性测试兜底，同耗材先例）。
