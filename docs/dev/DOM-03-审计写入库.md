# DOM-03 业务审计写入库

实现：[packages/database/src/audit.ts](../packages/database/src/audit.ts)；测试：[db03.test.ts](../packages/database/test/db03.test.ts)（8 项）。

## 1. 组成

| 能力 | 入口 | 说明 |
|---|---|---|
| 脱敏器 | `sanitizeAuditPayload(value)` | 递归遮蔽敏感字段名（`SENSITIVE_KEY_PATTERN`：privateKey/password/passwordHash/secret/token/verifier/credential/apiKey/accessKey 等，不区分大小写），替换为 `[REDACTED]`；公钥证书等正常字段保留 |
| 审计写入 | `recordAudit(client, entry)` | 追加 `audit_logs`；actorId/actorRole/customerId/requestId 默认取 DB-02 AsyncLocalStorage 上下文，显式传参优先；前后值先脱敏 |
| 写操作拦截器 | `audited(client, op, fn)` | 业务写入与 SUCCESS 审计同事务；业务失败整体回滚后**独立写入 FAILURE**（不伪造成功），原错误原样抛出；必须用根 `PrismaClient`（事务内嵌套抛 `DbError`） |
| append-only 防线 | `APPEND_ONLY_MODELS`（repository.ts） | `auditLog`/`deviceStateHistory`/`licenseHistory`/`otaStatusHistory`/`ingestionReceipt`/`ingestionGap` 的 `updateWithVersion`/`softDelete` 抛 `AppendOnlyViolationError`（→ 400） |

## 2. 供下游使用方式

- 所有管理写接口、Command/OTA/Replay：用 `audited(prisma, { objectType, objectId, action, reason, beforeValue, afterValue }, fn)` 包裹；
- DOM-01/02 的 `auditEvent` 描述符 → `recordAudit` 字段映射（BE 任务负责调用）；
- 敏感材料永不入审计负载：脱敏器兜底 + 测试断言序列化结果 0 泄露。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 审计记录不能通过业务 Repository 更新/删除 | auditLog 及三个历史表的 updateWithVersion/softDelete 均抛 `AppendOnlyViolationError` | ✅ |
| 敏感字段 0 泄露 | 嵌套/数组中的私钥、Token、passwordHash、verifier 全部 `[REDACTED]`，序列化断言不含原值 | ✅ |
| 失败记录失败结果但不伪造成功 | 业务回滚后仅存在 1 条 FAILURE；无 SUCCESS；原错误抛出 | ✅ |
| 附加 | 上下文传播（requestId/actor 默认注入）、成功路径业务+审计同事务、事务内嵌套 audited 拒绝 | ✅ |

全仓 `pnpm verify` 通过。

## 4. 未决风险

- 脱敏基于字段名规则：新增敏感字段命名若绕过词表需在 SEC 任务补充；未来可加值形态检测（如 PEM 头）做双保险；
- `audited` 失败审计与业务回滚之间存在极小窗口（先回滚后补记），进程崩溃时失败审计可能缺失——试运营可接受，SEC/QA 复核；
- 审计失败写入仅 `console.error` 兜底，结构化告警待 observability 包实现后接入。
