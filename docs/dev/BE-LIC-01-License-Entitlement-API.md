# BE-LIC-01 License/Entitlement API

实现：[apps/cloud-api/src/admin/license](../apps/cloud-api/src/admin/license/index.ts)；OpenAPI：[contracts/rest/admin-license-api.json](../contracts/rest/admin-license-api.json)；验收测试：[admin-license.test.ts](../apps/cloud-api/test/admin-license.test.ts)（8 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-LIC-01（P1 / 管理后台后端），依赖 DOM-02、AUTH-01、DOM-03（均已交付） |
| 状态机 | DOM-02 迁移表为唯一事实源：创建 Draft → Issue（Draft→Issued，生成签名）→ Activate（Issued→Active，SYSTEM）→ Renew（ExpiringSoon→Renewed，延长 validTo 并重签）→ Revoke（Active/Expired→Revoked，强制原因）；非法跳转/越权/缺原因由领域层抛 LicenseStateError |
| Entitlement | REST/签名使用源契约 `REMOTE_CONTROL / OTA / ESG_REPORTING`；历史 DB 码 `OTA_UPDATE` 只在服务内部映射；运行中 License 不提供 Entitlement 变更 |
| 功能边界 | 不实现定时 ExpiringSoon/Expired 扫描；提供可测试的 evaluate 入口（DOM-02 `evaluateLicenseAt` 时间派生 + Renewed→Active 结算，SYSTEM actor） |

## 2. 端点

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/licenses` | `license:write` | 创建 Draft：设备须已分配 Customer 且未退役；服务端生成 licenseId（审计 objectId 指向 license）；201 |
| `POST /api/v1/admin/licenses/{licenseId}/issue` | `license:write` | Draft→Issued，HMAC-SHA256 签名（base64url，规范载荷，密钥部署注入） |
| `POST /api/v1/admin/licenses/{licenseId}/activate` | `license:write` | Issued→Active（DOM-02 SYSTEM 迁移；要求 now≥validFrom，未来生效 → 409） |
| `POST /api/v1/admin/licenses/{licenseId}/renew` | `license:write` | ExpiringSoon→Renewed（newValidTo 强制）；同目标重放幂等返回（无写入/通知/审计）；异目标 409 |
| `POST /api/v1/admin/licenses/{licenseId}/revoke` | `license:write` | Active/Expired→Revoked，reason 强制（缺 → 400） |
| `POST /api/v1/admin/licenses/{licenseId}/evaluate` | `license:write` | 可测试时间派生（`at` 可注入）：Active→ExpiringSoon/Expired、ExpiringSoon→Expired、Renewed→Active 结算；无变化无写入 |
| `GET /api/v1/admin/licenses/{licenseId}` | `license:read` | 详情：含 signature（Draft 为 null）、version、effective（查询时点派生，DOM-02 `isLicenseEffective`） |
| `GET /api/v1/admin/licenses/{licenseId}/history` | `license:read` | 状态历史（倒序，上限 100） |

**唯一有效 License**：领域层 `ctx.noOtherValidLicense`（存在任一非终态 License 不可再建，含 Draft 避免草稿堆积）+ DB 部分唯一索引兜底（并发 P2002 → 409）；吊销/过期后可重建。

**每次真实状态变化恰好产生**：一条 license_history + 一次审计（action 用 DOM-02 `effects.auditEvent.action`，如 `license.draft_to_issued`）+ 一个 LICENSE_CHANGED Outbox（topic `bnx/device/{id}/notification`，data `{type, action:'SYNC'}`）；幂等重放与 evaluate 无变化时三者皆无。

**并发**：`licenses.version` 条件更新，版本漂移 → 409。

## 3. 验收基准与证据（vitest + PGlite，8 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 所有状态路径 | 完整链路 Draft→Issued→Active→ExpiringSoon→Renewed→Active→Expired→Revoked：每步状态/签名/历史/审计/通知各一次 | ✅ |
| renew 幂等 | 同目标回放无写入（replayed=true）；异目标 409；version 递增 | ✅ |
| 非法路径 | 非法迁移 409；revoke 缺原因/非法参数 400；evaluate 无变化无写入 | ✅ |
| 有效期约束 | activate 在 validFrom 之前 → 409 | ✅ |
| 一个设备不能出现两个有效 License | 并发撞部分唯一索引 → 409；吊销后可重建；未分配 Customer/已退役设备 409；Operator/SuperAdmin 放行、Auditor/Customer 403、未认证 401 | ✅ |
| 通知和审计各一次 | 链路测试对 audit_events / license_history / outbox_events 精确计数 | ✅ |
| 附加 | 错误码对齐 CT-05 目录；DTO 字段与 OpenAPI License 封闭契约一致；模块无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-license-api.test.ts`（3 项：端点封闭/Schema 封闭/$ref 可解析）。

## 4. 未决风险

- 签名机制已由 DEC-020@1.0.0 冻结：`v1.<HMAC-SHA256 base64url>`、固定规范载荷、环境级 Secrets Manager/KMS 密钥及 active/previous 双验轮换窗口；
- LICENSE_CHANGED 通知的实际 MQTT 投递依赖下行分发器（Outbox 当前仅归档链路）；
- ExpiringSoon/Expired 定时扫描按功能边界未实现，当前由调用方触发 evaluate（接入调度器即可，领域方法已可测试）；
- DOM-02 中 Issued→Active 为 SYSTEM 迁移，管理端 activate 端点以 SYSTEM actor 执行（等价系统激活事件）；如需区分人工激活角色需调整领域迁移表。
