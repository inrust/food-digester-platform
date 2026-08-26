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
| 契约 | `pnpm check:schemas` | 全部 JSON Schema 可解析、$ref 无悬空；OpenAPI 基座结构完整 |
| Migration | `pnpm check:migrations` | schema.prisma 存在时必须有非空合法 migrations/ |
| 敏感信息 | `pnpm check:secrets` | git 跟踪文件高精度扫描（PEM 私钥、AWS Key、GitHub/Slack Token） |

## 2. 测试运行器分工

- **Vitest**（`vitest.config.mjs`）：`apps/*`、`packages/*`、`infra` 单元测试；alias 指向共享包源码，不依赖 dist。
- **node:test + tsx**：`contracts/**`（CT 系列既有契约测试）与 `scripts/**`（门禁脚本测试）。

## 3. 门禁脚本与失败示例测试

| 脚本 | 失败示例测试 |
|---|---|
| [check-schemas.mjs](../scripts/check-schemas.mjs) | check-schemas.test.mjs：悬空 $ref、目标文件缺失、JSON 损坏、OpenAPI 缺 paths |
| [check-migrations.mjs](../scripts/check-migrations.mjs) | check-migrations.test.mjs：未提交 Migration、空 migrations/、非法目录名、空 migration.sql |
| [check-secrets.mjs](../scripts/check-secrets.mjs) | check-secrets.test.mjs：PEM 私钥、AWS Key、GitHub/Slack Token 负向 + 不误报正向 |
| [check-boundaries.mjs](../scripts/check-boundaries.mjs)（ENG-01） | check-boundaries.test.mjs：反向依赖、循环依赖 |

## 4. 验收基准实测记录

| 验收项 | 操作 | 结果 | 修复后 |
|---|---|---|---|
| 类型错误 | `observability/src/index.ts` 注入 `number = "str"` | `pnpm typecheck` 退出 2 | 还原后通过 |
| 失效 Schema | 注入悬空 `$ref` 的 `_gate-demo.schema.json` | `check:schemas` 退出 1，报 `$ref 目标不存在: #/definitions/ghost` | 删除后通过 |
| 未提交 Migration | 临时创建 `schema.prisma` 无 migrations/ | `check:migrations` 退出 1，报“未提交 Migration” | 还原后跳过通过 |
| 示例私钥 | 临时提交含 PEM 私钥块文件 | `check:secrets` 退出 1，报 `demo-key.pem:1 (pem-private-key)` | 移除后通过 |

最终 `pnpm verify` 全链退出 0（Vitest 12、contracts 128、scripts 52 项测试全部通过）。

## 5. 决策与说明

- `contracts/prototype-traceability.yaml` 与 `contracts/mqtt/payloads.ts` 排除在 Prettier 之外：前者按设计为 JSON 语法子集（零依赖 `JSON.parse`），后者为生成物（新鲜度由契约测试保证）。
- `docs/` 不纳入格式化门禁（规范文档版式由作者负责）。
- 敏感信息扫描只保留高精度模式，避免误报阻塞开发；测试文件中的示例密钥以字符串拼接构造，防止自命中。
- Migration 门禁在 DB-01 落地 `schema.prisma` 后自动生效。
- 曾检出并修复一处门禁脚本自身缺陷（二进制保护误判为空格匹配导致漏扫），修复后经负向演示确认有效。

## 6. 未决风险

- Vitest 与 node:test 双运行器并存；若后续要求唯一运行器，需在 CT 系列测试迁移后统一（涉及既有契约测试改造，超出 ENG-02 边界）。
- 敏感信息扫描为高精度静态规则，不能替代人工代码审查；误报/漏报规则增补由 SEC 系列任务接手。
