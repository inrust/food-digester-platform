# ENG-01 TypeScript Monorepo 骨架与模块边界

## 1. 工作区布局

| 路径 | 包名 | 职责边界 |
|---|---|---|
| `apps/cloud-api` | `@fdp/cloud-api` | `/api/v1/device`、`/admin`、`/customer`、`/internal` REST API（BE/CT-05 后续实现） |
| `apps/admin-web` | `@fdp/admin-web` | 管理后台前端；框架与页面由 FE-01 起按 `contracts/prototype-traceability.yaml` 落地 |
| `apps/ingestion-worker` | `@fdp/ingestion-worker` | IoT 消息接收、Schema 校验、幂等、隔离（BE-IOT） |
| `apps/archive-worker` | `@fdp/archive-worker` | 原始消息归档与重放（BE-ARC/BE-RPL） |
| `apps/summary-worker` | `@fdp/summary-worker` | 遥测聚合、ESG 计算与投影（BE-ESG） |
| `contracts` | `@fdp/contracts` | 协议与决策契约；源码契约包（见第 3 节） |
| `packages/domain` | `@fdp/domain` | 领域服务与状态机（DOM-01）；状态迁移唯一入口 |
| `packages/database` | `@fdp/database` | Prisma Schema、Migration、Repository（DB-01/DB-02） |
| `packages/aws-clients` | `@fdp/aws-clients` | AWS SDK 客户端封装（IAC/BE） |
| `packages/observability` | `@fdp/observability` | 结构化日志、requestId、审计上下文 |
| `infra` | `@fdp/infra` | 应用依赖的 AWS CDK 定义（IAC）；不含运维告警与值守配置 |

骨架期声明的依赖方向：`database → domain → contracts`，apps 只依赖共享包。

## 2. 技术基线

- Node.js `>=20.19 <21`（`package.json` engines、`.nvmrc` 固定 20.19.5）；TypeScript strict（`tsconfig.base.json`，`module: NodeNext`）。
- pnpm 10.20.0 workspace（`packageManager` 与 Node 20 兼容）+ Turborepo（`turbo.json`，`build` 按 `^build` 拓扑排序）。
- 测试运行器：`node --test` + `tsx`（兼容 Node 20；Vitest 由 ENG-02 统一引入）。
- ESLint flat config（`eslint.config.mjs`）；更严格的门禁规则（格式化、Schema/Migration/密钥扫描）由 ENG-02 收敛。

## 3. contracts 为源码契约包

`contracts/**/*.ts` 使用 `.ts` 扩展名互引（CT 系列既有约定，配合 Node 类型剥离运行），不能用 `tsc` emit 构建，否则需改写既有引用。因此：

- `@fdp/contracts` 的 `build` 为显式 no-op；`typecheck` 用 `allowImportingTsExtensions + noEmit`；
- 消费方（apps/packages）在运行期经 `tsx` 或打包器直接引用源码，骨架代码不编译 contracts；
- 可编译共享包（`packages/*`、`infra`）正常 `tsc` 输出 `dist/`，供 apps 类型解析与构建排序。

## 4. 模块边界规则（`scripts/check-boundaries.mjs` 强制执行）

1. 共享包（`packages/*`、`contracts`、`infra`）禁止反向依赖 `apps/*`；
2. 工作区依赖图禁止循环依赖；
3. `apps/*` 之间禁止互相依赖（复用只能经由共享包）。

非工作区（外部 npm）依赖不参与检查。违规时退出码 1 并打印违规清单。

## 5. 验收命令与证据

干净环境（新的 pnpm store，且无 `node_modules`、`dist`、`.turbo`）下顺序执行：

```bash
pnpm install            # 通过（含 pnpm-workspace.yaml 的 esbuild allowBuilds 声明）
pnpm lint               # eslint . 通过
pnpm typecheck          # turbo 12 包 tsc strict 通过
pnpm test               # 执行全部 Vitest、contracts 与 scripts 测试
pnpm build              # turbo 拓扑构建 12 包通过
pnpm check:boundaries   # 12 个包边界与循环依赖检查通过
```

也可单条执行 `pnpm verify` 串联以上全部检查。

2026-09-05 P2 验收的精确运行时、缓存与测试数量快照见[整改证据报告](../audit/ENG-DB-DOM-P2证据与文档维护报告-2026-09-05.md)；本文只保留可复验命令，避免总数随测试增长而失真。

## 6. 未决风险

- `admin-web` 前端框架（构建器、渲染方案）未在骨架期选型，由 FE-01 决定后再引入对应工具链；
- `noUncheckedIndexedAccess` 等超 strict 附加项未纳入基线（既有 contracts 测试未按该约束编写），是否收敛由 ENG-02 评估；
- `allowBuilds: { esbuild: true }` 为本环境 pnpm 供应链策略要求的最小授权，新增含构建脚本的依赖需逐条审批。
