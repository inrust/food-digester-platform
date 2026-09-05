# ENG-02 开发质量门禁

## 1. 单一验证命令

```bash
pnpm verify
```

按序执行，任一环节失败即整体失败（退出码非 0），本地与自动化环境均无交互：

| 步骤 | 命令 | 门禁内容 |
|---|---|---|
| Lint | `pnpm lint` | ESLint flat config（TS + MJS） |
| 格式化 | `pnpm format:check` | Prettier（`docs/`、锁文件、生成物除外，见 `.prettierignore`） |
| 类型 | `pnpm typecheck` | Turborepo 编排 12 包 tsc strict |
| 测试 | `pnpm test` | Vitest（apps/packages/infra）+ node:test（contracts、scripts） |
| 构建 | `pnpm build` | Turborepo 拓扑构建 |
| 模块边界 | `pnpm check:boundaries` | 反向依赖 / 循环依赖（ENG-01） |
| 契约 | `pnpm check:schemas` | 全部 JSON Schema 通过 Ajv 2020 元 Schema 校验且 `$ref` 无悬空；OpenAPI 由 Redocly 校验 |
| Migration | `pnpm check:migrations` | Migration 结构 + 最新 Schema SHA-256 快照 + PGlite 实际迁移结果与 Prisma 期望结构漂移检查 |
| 整改证据 | `pnpm check:evidence` | ENG/DB/DOM 七份开发文档链接、易漂移测试计数和 Node/pnpm 配对 |
| 敏感信息 | `pnpm check:secrets` | git tracked、staged、未忽略 untracked 文件高精度扫描（PEM 私钥、AWS Key、GitHub/Slack Token） |

## 2. 测试运行器分工

- **Vitest**（`vitest.config.mjs`）：`apps/*`、`packages/*`、`infra` 单元测试；alias 指向共享包源码，不依赖 dist。
- **node:test + tsx**：`contracts/**`（CT 系列既有契约测试）与 `scripts/**`（门禁脚本测试）。

## 3. 门禁脚本与失败示例测试

| 脚本 | 失败示例测试 |
|---|---|
| [check-schemas.mjs](../../scripts/check-schemas.mjs) | check-schemas.test.mjs：悬空 `$ref`、目标文件缺失、JSON 损坏、JSON Schema 2020-12 非法 `type`、OpenAPI 缺 paths |
| [check-migrations.mjs](../../scripts/check-migrations.mjs) | check-migrations.test.mjs：未提交 Migration、空 migrations/、非法目录名、空 SQL、旧 Migration 对应的 Schema 漂移；CLI 另执行真实结构比较 |
| [check-secrets.mjs](../../scripts/check-secrets.mjs) | check-secrets.test.mjs：PEM 私钥、AWS Key、GitHub/Slack Token、未跟踪私钥负向 + 不误报正向 |
| [check-boundaries.mjs](../../scripts/check-boundaries.mjs)（ENG-01） | check-boundaries.test.mjs：反向依赖、循环依赖 |
| [check-eng-db-dom-evidence.mjs](../../scripts/check-eng-db-dom-evidence.mjs) | check-eng-db-dom-evidence.test.mjs：损坏链接、陈旧测试计数、不兼容 Node/pnpm 声明 |

## 4. 验收基准实测记录

| 验收项 | 操作 | 结果 | 修复后 |
|---|---|---|---|
| 类型错误 | `observability/src/index.ts` 注入 `number = "str"` | `pnpm typecheck` 退出 2 | 还原后通过 |
| 失效 Schema | 注入悬空 `$ref` 的 `_gate-demo.schema.json` | `check:schemas` 退出 1，报 `$ref 目标不存在: #/definitions/ghost` | 删除后通过 |
| JSON Schema 语义错误 | 临时 Schema 设置非法 `type` | `check:schemas` 退出 1，报元 Schema 校验失败 | 修正后通过 |
| 未提交 Migration / Schema 漂移 | Schema 改变但最新 Migration 的 SHA-256 快照未同步，或全部 Migration 的最终结构与 Prisma 期望不一致 | `check:migrations` 退出 1，输出快照或列/键/索引漂移 | 补充向前 Migration 后通过 |
| 示例私钥 | 临时提交含 PEM 私钥块文件 | `check:secrets` 退出 1，报 `demo-key.pem:1 (pem-private-key)` | 移除后通过 |
| 未跟踪私钥 | 临时 Git 仓库中新建但不暂存 PEM 私钥 | `check:secrets` 检出该文件 | 移除后通过 |
| 整改证据漂移 | 注入损坏链接、旧测试总数或不兼容工具链声明 | `check:evidence` 退出 1 并列出具体文档/声明 | 修正文档或配置后通过 |

2026-09-05 P2 的当前工作树与隔离副本精确快照统一记录在[整改证据报告](../audit/ENG-DB-DOM-P2证据与文档维护报告-2026-09-05.md)。

## 5. 决策与说明

- `contracts/prototype-traceability.yaml` 与 `contracts/mqtt/payloads.ts` 排除在 Prettier 之外：前者按设计为 JSON 语法子集（零依赖 `JSON.parse`），后者为生成物（新鲜度由契约测试保证）。
- `docs/` 不纳入格式化门禁（规范文档版式由作者负责）。
- 敏感信息扫描只保留高精度模式，避免误报阻塞开发；测试文件中的示例密钥以字符串拼接构造，防止自命中。
- Migration 门禁在 DB-01 落地 `schema.prisma` 后自动生效；最新 Migration 的 `schema.sha256` 防止只改 Schema 不提交 Migration，PGlite/Prisma 双库比较负责验证最终列、主键/唯一键/外键和索引结构。
- 七份 ENG/DB/DOM 开发文档只保留可复验命令；精确测试数量集中写入带日期的审计快照，并由 `check:evidence` 阻止损坏链接和陈旧总数重新进入开发文档。
- 曾检出并修复一处门禁脚本自身缺陷（二进制保护误判为空格匹配导致漏扫），修复后经负向演示确认有效。

## 6. 未决风险

- Vitest 与 node:test 双运行器并存；若后续要求唯一运行器，需在 CT 系列测试迁移后统一（涉及既有契约测试改造，超出 ENG-02 边界）。
- 敏感信息扫描为高精度静态规则，不能替代人工代码审查；误报/漏报规则增补由 SEC 系列任务接手。
